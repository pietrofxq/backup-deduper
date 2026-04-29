import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import {
  createRun,
  getAction,
  listCollections,
  markActionRestored,
  setRunStatus,
  upsertFile,
  type QuarantineActionRow,
} from '../db/queries.js';
import { hashFileSync } from '../hasher/sha256.js';
import { fromDbRelPath, isPathWithin } from '../paths/relpath.js';
import { uniqueDest } from './uniqueDest.js';
import { toLongPath } from '../paths/winLong.js';
import { sentinelPaths } from '../target/sentinel.js';
import { appendAudit } from '../audit/log.js';

export type RestoreOutcome =
  | { kind: 'restored'; finalPath: string }
  | { kind: 'restored_sidecar'; finalPath: string; reason: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'errored'; error: string };

export interface RestoreOneOptions {
  /** Allow writing to a sidecar `(restored)` path if the target is occupied. */
  allowSidecar: boolean;
}

/**
 * Restore a single quarantine action.
 *
 * Procedure:
 *   1. Look up the action; refuse if it's not currently in quarantine
 *      (executed_at must be set; restored_at and purged_at must be null).
 *   2. Verify the quarantined file's hash still matches what we recorded.
 *      If not, refuse — the file may have been corrupted.
 *   3. Reconstruct the original abs path from (target_root, collection, rel_path).
 *   4. If the path is occupied:
 *        - if the occupant has the SAME hash, mark restored (no rename) — the
 *          live tree already has it.
 *        - else if `allowSidecar`, route to `<basename> (restored)<ext>`.
 *        - else, refuse and report.
 *   5. Rename quarantine→source. Update `file` row. Mark restored.
 */
export function restoreOne(
  db: Db,
  targetRoot: string,
  actionId: number,
  opts: RestoreOneOptions,
): RestoreOutcome {
  const action = getAction(db, actionId);
  if (!action) return { kind: 'skipped', reason: 'action not found' };
  if (!action.executed_at) return { kind: 'skipped', reason: 'action not executed yet' };
  if (action.restored_at) return { kind: 'skipped', reason: 'already restored' };
  if (action.purged_at) return { kind: 'skipped', reason: 'already purged' };

  const collection = findCollection(db, action.collection_id);
  if (!collection) return { kind: 'skipped', reason: 'collection missing' };

  const sourceAbs = path.join(
    targetRoot,
    collection.rel_path,
    fromDbRelPath(action.src_rel_path),
  );
  const destAbs = action.dest_abs_path;
  const { trashDir } = sentinelPaths(targetRoot);

  // Trust boundary: action.dest_abs_path comes from the DB and could in
  // theory be tampered with or corrupted. Without this fence, restoreOne
  // would happily rename an attacker-chosen path into the live tree —
  // turning a write to `quarantine_action` into arbitrary file movement
  // anywhere on the volume. The mirror of purge.ts's fence.
  if (!isPathWithin(trashDir, path.resolve(destAbs))) {
    return {
      kind: 'errored',
      error: `quarantine source path is outside .dedupe-trash (got ${destAbs})`,
    };
  }
  if (!isPathWithin(targetRoot, sourceAbs)) {
    return { kind: 'errored', error: 'source path escapes target_root' };
  }
  if (!fs.existsSync(toLongPath(destAbs))) {
    return { kind: 'errored', error: `quarantine file missing at ${destAbs}` };
  }

  // 2. re-verify under fresh hash.
  if (action.sha256_hex) {
    const fresh = hashFileSync(destAbs);
    if (fresh !== action.sha256_hex) {
      return {
        kind: 'errored',
        error: `quarantined hash mismatch (recorded=${action.sha256_hex}, fresh=${fresh})`,
      };
    }
  }

  // 4. occupancy check
  let finalPath = sourceAbs;
  let outcomeKind: 'restored' | 'restored_sidecar' = 'restored';
  let outcomeReason = '';
  if (fs.existsSync(toLongPath(sourceAbs))) {
    const occupantHash = action.sha256_hex ? hashFileSync(sourceAbs) : null;
    if (occupantHash && occupantHash === action.sha256_hex) {
      // The live tree already has the same content — count as restored
      // without moving anything; just bookkeeping.
      markActionRestored(db, action.id);
      // Re-upsert file row in case it was deleted.
      upsertFile(
        db,
        action.collection_id,
        action.src_rel_path,
        action.size,
        Math.floor(fs.lstatSync(toLongPath(sourceAbs)).mtimeMs),
        action.sha256_hex,
        0,
      );
      appendAudit(targetRoot, 'restore_skipped', {
        actionId,
        reason: 'live_tree_already_has_same_hash',
      });
      return { kind: 'restored', finalPath: sourceAbs };
    }
    if (!opts.allowSidecar) {
      return {
        kind: 'errored',
        error: `target path occupied by different content; pass allowSidecar to route to <basename> (restored)<ext>`,
      };
    }
    finalPath = sidecarPath(sourceAbs);
    finalPath = uniqueDest(finalPath);
    outcomeKind = 'restored_sidecar';
    outcomeReason = 'target path occupied by different content';
  }

  // 5. rename
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.renameSync(toLongPath(destAbs), toLongPath(finalPath));

  // Re-upsert file row (so subsequent scans cache-hit).
  let mtime = 0;
  try {
    mtime = Math.floor(fs.lstatSync(toLongPath(finalPath)).mtimeMs);
  } catch {
    /* leave at 0; next scan will refresh */
  }
  upsertFile(
    db,
    action.collection_id,
    fileRelOf(targetRoot, collection.rel_path, finalPath),
    action.size,
    mtime,
    action.sha256_hex,
    0,
  );

  markActionRestored(db, action.id);
  appendAudit(targetRoot, 'restore_complete', {
    actionId,
    finalPath,
    outcomeKind,
  });
  if (outcomeKind === 'restored_sidecar') {
    return { kind: 'restored_sidecar', finalPath, reason: outcomeReason };
  }
  return { kind: 'restored', finalPath };
}

export interface BulkRestoreInput {
  db: Db;
  targetRoot: string;
  actionIds: number[];
  allowSidecar: boolean;
}

export interface BulkRestoreSummary {
  runId: number;
  outcomes: Array<{ actionId: number; outcome: RestoreOutcome }>;
}

export function bulkRestore(input: BulkRestoreInput): BulkRestoreSummary {
  const { db, targetRoot, actionIds, allowSidecar } = input;
  const runId = createRun(db, 'restore', false, { actionIds, allowSidecar });
  const outcomes: BulkRestoreSummary['outcomes'] = [];
  try {
    for (const id of actionIds) {
      outcomes.push({ actionId: id, outcome: restoreOne(db, targetRoot, id, { allowSidecar }) });
    }
    setRunStatus(db, runId, 'completed');
    return { runId, outcomes };
  } catch (err) {
    setRunStatus(db, runId, 'failed');
    throw err;
  }
}

function sidecarPath(absPath: string): string {
  const dir = path.dirname(absPath);
  const ext = path.extname(absPath);
  const base = path.basename(absPath, ext);
  return path.join(dir, `${base} (restored)${ext}`);
}

function fileRelOf(targetRoot: string, collectionRelPath: string, finalAbs: string): string {
  const baseAbs = path.join(targetRoot, collectionRelPath);
  return path.relative(baseAbs, finalAbs).split(path.sep).join('/');
}

function findCollection(db: Db, id: number) {
  return listCollections(db).find((c) => c.id === id);
}

export type { QuarantineActionRow };
