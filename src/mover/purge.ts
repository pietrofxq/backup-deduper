import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import {
  createRun,
  listActiveActions,
  markActionPurged,
  setRunStatus,
  type QuarantineActionRow,
} from '../db/queries.js';
import { sentinelPaths } from '../target/sentinel.js';
import { toLongPath } from '../paths/winLong.js';
import { isPathWithin } from '../paths/relpath.js';
import { appendAudit } from '../audit/log.js';
import { parseSqliteDatetime } from '../db/datetime.js';

export interface PurgeOptions {
  db: Db;
  targetRoot: string;
  /** Days an action must be in quarantine before it's eligible. */
  retentionDays: number;
  /** When true, do not delete; just report what would be purged. */
  dryRun: boolean;
  /** Override "now" for testability. */
  now?: Date;
}

export interface PurgeSummary {
  runId: number;
  eligible: number;
  purgedFiles: number;
  purgedBytes: number;
  emptyTrashDirsRemoved: number;
  errored: number;
  dryRun: boolean;
}

/**
 * Purge actions that have been quarantined for >= `retentionDays`.
 *
 * Safety:
 *   - Only deletes files inside `<target_root>/.dedupe-trash/`. A path that
 *     escapes that prefix is refused and audited.
 *   - Time-gated by `executed_at`. An action with executed_at not yet old
 *     enough is skipped.
 *   - Restored or already-purged actions are excluded by listActiveActions().
 *   - Never invoked by the scan or quarantine job — this is a separate runner.
 */
export function purge(opts: PurgeOptions): PurgeSummary {
  const { db, targetRoot, retentionDays, dryRun } = opts;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const { trashDir } = sentinelPaths(targetRoot);

  const runId = createRun(db, 'purge', dryRun, { retentionDays, dryRun, cutoff: cutoff.toISOString() });
  const summary: PurgeSummary = {
    runId,
    eligible: 0,
    purgedFiles: 0,
    purgedBytes: 0,
    emptyTrashDirsRemoved: 0,
    errored: 0,
    dryRun,
  };

  try {
    const all = listActiveActions(db);
    for (const a of all) {
      if (!isOldEnough(a, cutoff)) continue;
      summary.eligible += 1;

      const dest = a.dest_abs_path;
      // Hard guard: must live strictly inside trashDir. Use path.relative
      // (case-insensitive on Windows, case-sensitive on POSIX — matching the
      // FS) instead of a startsWith on resolved absolutes; otherwise drive-
      // letter casing variance on Windows would make legitimate paths fail
      // the fence (or, worse, an attacker-controlled casing could pass it).
      //
      // Defend against symlink injection: if a previous bug or a user with
      // shell access placed a symlink under .dedupe-trash/ that points to a
      // file outside the trash, `unlinkSync(dest)` would happily follow the
      // path resolution rules. Using `fs.realpathSync` collapses the link
      // first; we re-fence the real target. ENOENT is fine — falls through
      // to the unlink which will record it as already gone.
      let abs: string;
      try {
        abs = fs.realpathSync(toLongPath(path.resolve(dest)));
      } catch {
        abs = path.resolve(dest);
      }
      const trashAbs = path.resolve(trashDir);
      if (!isPathWithin(trashAbs, abs)) {
        appendAudit(targetRoot, 'purge_refused', {
          actionId: a.id,
          dest,
          reason: 'outside trashDir',
          realPath: abs,
        });
        summary.errored += 1;
        continue;
      }
      if (dryRun) {
        summary.purgedFiles += 1;
        summary.purgedBytes += a.size;
        continue;
      }
      try {
        fs.unlinkSync(toLongPath(dest));
        markActionPurged(db, a.id);
        summary.purgedFiles += 1;
        summary.purgedBytes += a.size;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // Already gone — record as purged.
          markActionPurged(db, a.id);
          summary.purgedFiles += 1;
        } else {
          appendAudit(targetRoot, 'purge_error', {
            actionId: a.id,
            error: err instanceof Error ? err.message : String(err),
          });
          summary.errored += 1;
        }
      }
    }

    if (!dryRun) {
      summary.emptyTrashDirsRemoved = removeEmptyTrashSubdirs(trashDir);
    }
    setRunStatus(db, runId, 'completed');
    appendAudit(targetRoot, 'purge_complete', { ...summary });
    return summary;
  } catch (err) {
    setRunStatus(db, runId, 'failed');
    appendAudit(targetRoot, 'purge_failed', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function isOldEnough(a: QuarantineActionRow, cutoff: Date): boolean {
  if (!a.executed_at) return false;
  return parseSqliteDatetime(a.executed_at).getTime() <= cutoff.getTime();
}

/** Remove empty subdirectories under trashDir bottom-up. Returns the count removed. */
function removeEmptyTrashSubdirs(trashDir: string): number {
  if (!fs.existsSync(trashDir)) return 0;
  let removed = 0;
  const stack: string[] = [trashDir];
  const allDirs: string[] = [];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const sub = path.join(d, e.name);
        stack.push(sub);
        allDirs.push(sub);
      }
    }
  }
  // Bottom-up by depth so we delete leaves first.
  allDirs.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const d of allDirs) {
    try {
      const entries = fs.readdirSync(d);
      if (entries.length === 0) {
        fs.rmdirSync(d);
        removed += 1;
      }
    } catch {
      /* swallow; best-effort */
    }
  }
  return removed;
}
