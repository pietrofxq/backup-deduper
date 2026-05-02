import type { Db } from '../db/index.js';
import { createRun, getPrimary, getRun, setRunStatus } from '../db/queries.js';
import { executeQuarantine, type QuarantineSummary } from '../mover/quarantine.js';
import type { EmptyDir, PlannedAction } from '../classifier/rules.js';
import { loadConfig, saveConfig } from '../config/loader.js';
import { CONFIRMATION_PHRASE } from '../config/schema.js';
import { checkSanityGuard, type SanityGuardResult } from './sanityGuard.js';
import { appendAudit } from '../audit/log.js';
import { parseSqliteDatetime } from '../db/datetime.js';

export class DryRunGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DryRunGateError';
  }
}

export class SanityGuardError extends Error {
  constructor(
    message: string,
    public readonly guard: SanityGuardResult,
  ) {
    super(message);
    this.name = 'SanityGuardError';
  }
}

export interface QuarantineJobInput {
  db: Db;
  targetRoot: string;
  /** The scan run id whose actions/empty-dirs are to be executed. */
  scanRunId: number;
  actions: PlannedAction[];
  emptyDirs: EmptyDir[];
  /** Pass true to bypass the sanity guard, after explicit user override. */
  ignoreSanityGuard?: boolean;
  /**
   * The primary collection id at the time the scan was classified, or
   * null if no primary was set then. The classifier's keeper-picking
   * is shaped by this — losers under cross-collection dedup are chosen
   * relative to which collection is primary, AND the within-collection
   * canonical winner respects the primary's path priority. If the user
   * has switched primary (or set one for the first time, or cleared
   * it) since the scan, the cached plan is stale: applying it would
   * quarantine files inside what is now the source-of-truth collection.
   *
   * REQUIRED. Made required intentionally so future call sites cannot
   * silently bypass the stale-plan check by omitting the field.
   * Callers that don't have a real scan run (property tests, fixtures
   * that construct PlannedActions by hand) should still pass an
   * explicit value — typically the current primary id read from the
   * DB, since their plans are constructed *against* that state.
   */
  scanPrimaryId: number | null;
}

export interface QuarantineJobResult {
  runId: number;
  summary: QuarantineSummary;
  guard: SanityGuardResult;
}

export function runQuarantineJob(input: QuarantineJobInput): QuarantineJobResult {
  const { db, targetRoot, scanRunId, actions, emptyDirs } = input;
  const cfg = loadConfig(db);

  if (cfg.dry_run) {
    throw new DryRunGateError(
      `dry_run is enabled. Type the confirmation phrase ("${CONFIRMATION_PHRASE}") at the disable-dry-run endpoint first.`,
    );
  }

  // Stale-plan refusal: the classifier's keeper-picking is anchored on
  // whichever collection was primary at scan time. If the primary has
  // changed since (or was set/cleared/swapped between scan and apply),
  // the cached actions reflect the *old* anchor — applying them would
  // quarantine files that the user just marked as their source-of-truth.
  //
  // The recomputed `checkSanityGuard` below cannot catch this on its own:
  // a small duplicate set under the new primary keeps the pct figures
  // under the limits, so the run would silently proceed against a stale
  // plan. The only signal that survives is the scan-time primary id —
  // compare it to the current primary and refuse on any mismatch.
  //
  // The code is always `primary_changed` (every direction: null→A,
  // A→null, A→B); `no_primary_set` is reserved for the live signal
  // emitted by `checkSanityGuard` so each code has exactly one origin.
  if (!input.ignoreSanityGuard) {
    const currentPrimaryId = getPrimary(db)?.id ?? null;
    if (input.scanPrimaryId !== currentPrimaryId) {
      const reason =
        `Primary collection state changed since scan (scan-time id=${input.scanPrimaryId ?? 'null'},` +
        ` current id=${currentPrimaryId ?? 'null'}); the cached action plan was shaped` +
        ' around the scan-time primary and would now apply against a different anchor.' +
        ' Rescan to refresh, or pass ignoreSanityGuard=true to apply the stale plan.';
      throw new SanityGuardError(reason, {
        passed: false,
        primaryFiles: 0,
        primaryBytes: 0,
        plannedFiles: actions.length,
        plannedBytes: actions.reduce((a, b) => a + b.size, 0),
        filesPct: 0,
        bytesPct: 0,
        reason,
        code: 'primary_changed',
      });
    }
  }

  const guard = checkSanityGuard(db, actions, {
    filesPctLimit: cfg.sanity_guard_files_pct,
    bytesPctLimit: cfg.sanity_guard_bytes_pct,
    emptyDirCount: emptyDirs.length,
  });
  if (!guard.passed && !input.ignoreSanityGuard) {
    throw new SanityGuardError(
      `Sanity guard refused: ${guard.reason}. Set ignoreSanityGuard=true to override.`,
      guard,
    );
  }

  const scanRun = getRun(db, scanRunId);
  const runStartedAtIso = scanRun?.started_at
    ? parseSqliteDatetime(scanRun.started_at).toISOString()
    : new Date().toISOString();

  const runId = createRun(db, 'quarantine', false, {
    scanRunId,
    actions: actions.length,
    emptyDirs: emptyDirs.length,
    ignoreSanityGuard: !!input.ignoreSanityGuard,
  });

  try {
    const summary = executeQuarantine({ db, targetRoot, runId }, actions, emptyDirs, runStartedAtIso);
    setRunStatus(db, runId, 'completed');
    appendAudit(targetRoot, 'quarantine_complete', { runId, ...summary, guard });
    return { runId, summary, guard };
  } catch (err) {
    setRunStatus(db, runId, 'failed');
    appendAudit(targetRoot, 'quarantine_failed', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Disable dry_run by typing the confirmation phrase. Persisted to config so
 * subsequent quarantine runs proceed without re-confirming.
 */
export function disableDryRun(db: Db, phrase: string, targetRoot: string): void {
  if (phrase !== CONFIRMATION_PHRASE) {
    throw new DryRunGateError(
      `Wrong confirmation phrase. Type exactly: ${CONFIRMATION_PHRASE}`,
    );
  }
  const cfg = loadConfig(db);
  cfg.dry_run = false;
  cfg.dry_run_disabled_at = new Date().toISOString();
  saveConfig(db, cfg);
  appendAudit(targetRoot, 'dry_run_disabled', { at: cfg.dry_run_disabled_at });
}
