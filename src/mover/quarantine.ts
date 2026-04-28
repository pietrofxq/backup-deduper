import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import {
  deleteFileRow,
  insertPlannedAction,
  markActionError,
  markActionExecuted,
} from '../db/queries.js';
import type { PlannedAction, EmptyDir } from '../classifier/rules.js';
import { hashFileSync } from '../hasher/sha256.js';
import { sentinelPaths } from '../target/sentinel.js';
import { fromDbRelPath, isPathWithin } from '../paths/relpath.js';
import { uniqueDest } from './uniqueDest.js';
import { toLongPath } from '../paths/winLong.js';
import { appendAudit } from '../audit/log.js';

export interface QuarantineDeps {
  db: Db;
  targetRoot: string;
  runId: number;
}

export interface QuarantineSummary {
  attempted: number;
  executed: number;
  errored: number;
  skippedHashMismatch: number;
  skippedSourceMissing: number;
  emptyDirsRemoved: number;
}

/**
 * Build the quarantine destination for a single action.
 *
 * Layout (matches PLAN/README):
 *   <target_root>/.dedupe-trash/<ISO-timestamp>-run-<id>/<collection>/<rel-path>
 */
export function quarantineDestFor(
  targetRoot: string,
  runId: number,
  runStartedAtIso: string,
  collectionRelPath: string,
  fileRelPath: string,
): string {
  const { trashDir } = sentinelPaths(targetRoot);
  // ISO timestamps contain ':' which is illegal on NTFS — replace with '-'.
  const tsSafe = runStartedAtIso.replace(/[:]/g, '-');
  const runDir = path.join(trashDir, `${tsSafe}-run-${runId}`);
  return path.join(runDir, collectionRelPath, fromDbRelPath(fileRelPath));
}

/**
 * Execute a list of planned actions in two-phase-commit order.
 *
 * Per action, in this exact order:
 *   1. pre-flight stat — if source disappeared, mark error and continue.
 *   2. re-hash from disk — if it differs from the classifier's hash, refuse
 *      and mark error. (This honors the safety invariant: never trust the old
 *      hash across the classify→move gap.)
 *   3. INSERT planned row (DB).
 *   4. mkdir -p the destination's parent directory.
 *   5. compute a unique destination via `uniqueDest()` — if the canonical
 *      dest path is already occupied (e.g. a residual from a prior crashed
 *      run, or a name collision), pick `<basename> (1).<ext>`,
 *      `<basename> (2).<ext>`, etc. so the rename never overwrites.
 *   6. fs.renameSync source → destination.
 *   7. post-move verify: stat destination, compare size to the recorded size.
 *   8. UPDATE row to set executed_at + verified_at.
 *   9. DELETE file row from `file` (it's now in quarantine, not the live tree).
 *
 * If the process is killed between (3) and (8), startup reconcile in
 * mover/reconcile.ts handles the leftover row.
 */
export function executeQuarantine(
  deps: QuarantineDeps,
  actions: PlannedAction[],
  emptyDirs: EmptyDir[],
  runStartedAtIso: string,
): QuarantineSummary {
  const { db, targetRoot, runId } = deps;
  const summary: QuarantineSummary = {
    attempted: actions.length,
    executed: 0,
    errored: 0,
    skippedHashMismatch: 0,
    skippedSourceMissing: 0,
    emptyDirsRemoved: 0,
  };

  for (const action of actions) {
    const srcAbs = path.join(
      targetRoot,
      action.collection.rel_path,
      fromDbRelPath(action.file.rel_path),
    );
    if (!isPathWithin(targetRoot, srcAbs)) {
      // Defense in depth — should be impossible given DB rel-paths.
      appendAudit(targetRoot, 'quarantine_skip', {
        reason: 'src_outside_target_root',
        srcAbs,
      });
      summary.errored += 1;
      continue;
    }

    // 1. pre-flight stat
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(toLongPath(srcAbs));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Source disappeared — possibly a previous crash or external change.
        // Drop the now-stale file row; it will reappear on a future scan if needed.
        deleteFileRow(db, action.collection.id, action.file.rel_path);
        appendAudit(targetRoot, 'quarantine_skip', {
          reason: 'source_missing',
          srcAbs,
        });
        summary.skippedSourceMissing += 1;
        continue;
      }
      throw err;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      appendAudit(targetRoot, 'quarantine_skip', {
        reason: 'not_a_regular_file',
        srcAbs,
      });
      summary.errored += 1;
      continue;
    }

    // 2. re-verify under fresh hash IF we have a recorded hash. Cruft files
    // may have null hashes (the classifier doesn't require a hash to flag
    // cruft); for those we skip re-hashing because there is no recorded value
    // to compare against.
    if (action.file.sha256_hex) {
      let freshHash: string;
      try {
        freshHash = hashFileSync(srcAbs);
      } catch (err) {
        appendAudit(targetRoot, 'quarantine_error', {
          srcAbs,
          error: err instanceof Error ? err.message : String(err),
        });
        summary.errored += 1;
        continue;
      }
      if (freshHash !== action.file.sha256_hex) {
        appendAudit(targetRoot, 'quarantine_skip', {
          reason: 'hash_mismatch',
          srcAbs,
          recorded: action.file.sha256_hex,
          fresh: freshHash,
        });
        summary.skippedHashMismatch += 1;
        continue;
      }
    }

    // 3. compute destination, ensure parent, INSERT planned row
    const desiredDest = quarantineDestFor(
      targetRoot,
      runId,
      runStartedAtIso,
      action.collection.rel_path,
      action.file.rel_path,
    );
    const destAbs = uniqueDest(desiredDest);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });

    const actionId = insertPlannedAction(db, {
      runId,
      collectionId: action.collection.id,
      srcRelPath: action.file.rel_path,
      destAbsPath: destAbs,
      size: action.file.size,
      sha256: action.file.sha256_hex,
      reason: action.reason,
    });

    // 4-5. same-volume rename. Refuse if root differs (defensive).
    if (path.parse(srcAbs).root !== path.parse(destAbs).root) {
      markActionError(db, actionId, 'cross-volume rename rejected');
      summary.errored += 1;
      continue;
    }
    try {
      fs.renameSync(toLongPath(srcAbs), toLongPath(destAbs));
    } catch (err) {
      markActionError(db, actionId, err instanceof Error ? err.message : String(err));
      summary.errored += 1;
      continue;
    }

    // 6. post-move verify
    let postStat: fs.Stats;
    try {
      postStat = fs.lstatSync(toLongPath(destAbs));
    } catch (err) {
      // The rename succeeded but verification failed — this is alarming. Try
      // to put the file back; if that fails, we surface the error and bail.
      const restoreErr = tryRestore(srcAbs, destAbs);
      markActionError(
        db,
        actionId,
        `post-move stat failed: ${err instanceof Error ? err.message : String(err)}` +
          (restoreErr ? `; restore-attempt-failed: ${restoreErr}` : '; restored to source'),
      );
      summary.errored += 1;
      continue;
    }
    if (postStat.size !== action.file.size) {
      const restoreErr = tryRestore(srcAbs, destAbs);
      markActionError(
        db,
        actionId,
        `post-move size mismatch: expected ${action.file.size}, got ${postStat.size}` +
          (restoreErr ? `; restore-attempt-failed: ${restoreErr}` : '; restored to source'),
      );
      summary.errored += 1;
      continue;
    }

    // 7. mark executed
    markActionExecuted(db, actionId);
    // 8. drop live file row — it's now under quarantine.
    deleteFileRow(db, action.collection.id, action.file.rel_path);
    summary.executed += 1;
  }

  // Empty-dir sweep: only touch directories that are STILL empty after the
  // file moves (a dir that became empty by our doing is fair game).
  for (const e of emptyDirs) {
    const abs = path.join(targetRoot, e.collection.rel_path, fromDbRelPath(e.relPath));
    if (!isPathWithin(targetRoot, abs)) continue;
    try {
      const entries = fs.readdirSync(abs);
      if (entries.length === 0) {
        fs.rmdirSync(abs);
        summary.emptyDirsRemoved += 1;
        appendAudit(targetRoot, 'empty_dir_removed', { abs });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      appendAudit(targetRoot, 'empty_dir_skip', {
        abs,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

function tryRestore(srcAbs: string, destAbs: string): string | null {
  try {
    fs.renameSync(toLongPath(destAbs), toLongPath(srcAbs));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
