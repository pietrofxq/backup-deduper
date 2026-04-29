import type { Db } from '../db/index.js';
import { getPrimary, listFilesInCollection } from '../db/queries.js';
import type { PlannedAction } from '../classifier/rules.js';

export interface SanityGuardInput {
  filesPctLimit: number; // e.g. 0.5
  bytesPctLimit: number; // e.g. 0.7
}

export interface SanityGuardResult {
  passed: boolean;
  primaryFiles: number;
  primaryBytes: number;
  plannedFiles: number;
  plannedBytes: number;
  filesPct: number;
  bytesPct: number;
  reason: string | null;
}

/**
 * Refuses to run a quarantine pass if the planned actions would touch more
 * than `filesPctLimit` of the primary collection's file count OR more than
 * `bytesPctLimit` of its byte total.
 *
 * Returns a structured result; caller decides whether to abort or override.
 */
export function checkSanityGuard(
  db: Db,
  actions: PlannedAction[],
  input: SanityGuardInput,
): SanityGuardResult {
  const primary = getPrimary(db);
  if (!primary) {
    return {
      passed: true,
      primaryFiles: 0,
      primaryBytes: 0,
      plannedFiles: actions.length,
      plannedBytes: actions.reduce((a, b) => a + b.size, 0),
      filesPct: 0,
      bytesPct: 0,
      reason: null,
    };
  }
  const primaryFiles = listFilesInCollection(db, primary.id);
  const primaryFileCount = primaryFiles.length;
  const primaryBytes = primaryFiles.reduce((a, b) => a + b.size, 0);

  // Sanity guard is about the primary's exposure. Count only actions that
  // target the primary (within-collection dedup or its rare cruft).
  const primaryActions = actions.filter((a) => a.collection.id === primary.id);
  const plannedFiles = primaryActions.length;
  const plannedBytes = primaryActions.reduce((a, b) => a + b.size, 0);

  const filesPct = primaryFileCount === 0 ? 0 : plannedFiles / primaryFileCount;
  const bytesPct = primaryBytes === 0 ? 0 : plannedBytes / primaryBytes;

  const filesTrip = filesPct > input.filesPctLimit;
  const bytesTrip = bytesPct > input.bytesPctLimit;
  if (filesTrip || bytesTrip) {
    return {
      passed: false,
      primaryFiles: primaryFileCount,
      primaryBytes,
      plannedFiles,
      plannedBytes,
      filesPct,
      bytesPct,
      reason:
        (filesTrip ? `files ${(filesPct * 100).toFixed(1)}% > ${(input.filesPctLimit * 100).toFixed(0)}%` : '') +
        (filesTrip && bytesTrip ? ' and ' : '') +
        (bytesTrip ? `bytes ${(bytesPct * 100).toFixed(1)}% > ${(input.bytesPctLimit * 100).toFixed(0)}%` : ''),
    };
  }

  return {
    passed: true,
    primaryFiles: primaryFileCount,
    primaryBytes,
    plannedFiles,
    plannedBytes,
    filesPct,
    bytesPct,
    reason: null,
  };
}
