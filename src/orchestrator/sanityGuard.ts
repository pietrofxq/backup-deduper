import type { Db } from '../db/index.js';
import { getPrimary, listFilesInCollection } from '../db/queries.js';
import type { PlannedAction } from '../classifier/rules.js';

export interface SanityGuardInput {
  filesPctLimit: number; // e.g. 0.5
  bytesPctLimit: number; // e.g. 0.7
  /**
   * Number of empty-directory removals planned for the same run. The mover
   * applies these as `rmdirSync` mutations on the live tree, so they have
   * to count toward the no-primary fail-closed branch — a run that emits
   * zero file actions but several empty-dir removals would otherwise slip
   * past as "vacuous" even though it mutates the tree.
   */
  emptyDirCount?: number;
}

/**
 * Structured failure code for a tripped sanity guard. Kept separate from
 * `reason` (a human-readable string) so the UI / clients can branch on a
 * stable identifier without parsing prose.
 *
 * Each code has exactly one origin so clients can branch unambiguously
 * without parsing prose:
 *
 * - `no_primary_set`: emitted by `checkSanityGuard` when current primary
 *   is null AND the run would do anything (file action or empty-dir
 *   removal). The dedup canonical-keeper logic falls back to lex
 *   tiebreak in that state — quarantining (or rmdir'ing) without a
 *   deliberately chosen primary is exactly the footgun the sanity
 *   guard exists to prevent. Live signal — user just needs to mark a
 *   primary, then can re-attempt.
 * - `primary_changed`: emitted by `runQuarantineJob` whenever the
 *   cached scan's `scanPrimaryId` differs from the current primary
 *   (any direction — null→A, A→null, A→B). The classifier picked
 *   losers relative to scan-time primary; applying that plan now
 *   would quarantine files in the wrong anchor. Stale signal — user
 *   must rescan to refresh the plan, even if they've already chosen
 *   a (possibly different) primary.
 * - `pct_exceeded`: planned actions exceed the configured files /
 *   bytes percentage of the current primary collection.
 */
export type SanityGuardCode = 'no_primary_set' | 'primary_changed' | 'pct_exceeded';

export interface SanityGuardResult {
  passed: boolean;
  primaryFiles: number;
  primaryBytes: number;
  plannedFiles: number;
  plannedBytes: number;
  filesPct: number;
  bytesPct: number;
  reason: string | null;
  /** Stable identifier when `passed === false`. Null when `passed === true`. */
  code: SanityGuardCode | null;
}

/**
 * Refuses to run a quarantine pass if either:
 *   1. there is no primary set AND the run would emit at least one action
 *      (would-be a vacuous pass — the dedup tiebreak runs without an
 *      anchor, leaving the user no "this is the safe baseline" guarantee), OR
 *   2. the planned actions would touch more than `filesPctLimit` of the
 *      primary collection's file count OR more than `bytesPctLimit` of its
 *      byte total.
 *
 * Returns a structured result; caller decides whether to abort or override.
 */
export function checkSanityGuard(
  db: Db,
  actions: PlannedAction[],
  input: SanityGuardInput,
): SanityGuardResult {
  const primary = getPrimary(db);
  const plannedBytes = actions.reduce((a, b) => a + b.size, 0);
  const emptyDirCount = input.emptyDirCount ?? 0;
  if (!primary) {
    // No-op runs (no actions AND no empty-dir removals emitted) are safe
    // regardless of primary state — the user hasn't been prompted to confirm
    // anything yet. A populated run without a primary IS dangerous: the
    // canonical-keeper picker has no anchor, so a duplicate-cross-collection
    // action could quarantine a file the user thought of as their source of
    // truth, AND the empty-dir sweep mutates the live tree on its own.
    if (actions.length === 0 && emptyDirCount === 0) {
      return {
        passed: true,
        primaryFiles: 0,
        primaryBytes: 0,
        plannedFiles: 0,
        plannedBytes: 0,
        filesPct: 0,
        bytesPct: 0,
        reason: null,
        code: null,
      };
    }
    return {
      passed: false,
      primaryFiles: 0,
      primaryBytes: 0,
      plannedFiles: actions.length,
      plannedBytes,
      filesPct: 0,
      bytesPct: 0,
      reason:
        'no primary collection set; mark one as primary before running quarantine',
      code: 'no_primary_set',
    };
  }
  const primaryFiles = listFilesInCollection(db, primary.id);
  const primaryFileCount = primaryFiles.length;
  const primaryBytes = primaryFiles.reduce((a, b) => a + b.size, 0);

  // Sanity guard is about the primary's exposure. Count only actions that
  // target the primary (within-collection dedup or its rare cruft).
  const primaryActions = actions.filter((a) => a.collection.id === primary.id);
  const plannedFiles = primaryActions.length;
  const primaryPlannedBytes = primaryActions.reduce((a, b) => a + b.size, 0);

  const filesPct = primaryFileCount === 0 ? 0 : plannedFiles / primaryFileCount;
  const bytesPct = primaryBytes === 0 ? 0 : primaryPlannedBytes / primaryBytes;

  const filesTrip = filesPct > input.filesPctLimit;
  const bytesTrip = bytesPct > input.bytesPctLimit;
  if (filesTrip || bytesTrip) {
    return {
      passed: false,
      primaryFiles: primaryFileCount,
      primaryBytes,
      plannedFiles,
      plannedBytes: primaryPlannedBytes,
      filesPct,
      bytesPct,
      reason:
        (filesTrip ? `files ${(filesPct * 100).toFixed(1)}% > ${(input.filesPctLimit * 100).toFixed(0)}%` : '') +
        (filesTrip && bytesTrip ? ' and ' : '') +
        (bytesTrip ? `bytes ${(bytesPct * 100).toFixed(1)}% > ${(input.bytesPctLimit * 100).toFixed(0)}%` : ''),
      code: 'pct_exceeded',
    };
  }

  return {
    passed: true,
    primaryFiles: primaryFileCount,
    primaryBytes,
    plannedFiles,
    plannedBytes: primaryPlannedBytes,
    filesPct,
    bytesPct,
    reason: null,
    code: null,
  };
}
