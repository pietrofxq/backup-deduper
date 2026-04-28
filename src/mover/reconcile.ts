import fs from 'node:fs';
import path from 'node:path';
import {
  findRunningRuns,
  getPendingActions,
  listCollections,
  markActionError,
  markActionExecuted,
  setRunStatus,
  type CollectionRow,
} from '../db/queries.js';
import type { Db } from '../db/index.js';
import { appendAudit } from '../audit/log.js';
import { hashFileSync } from '../hasher/sha256.js';
import { fromDbRelPath } from '../paths/relpath.js';
import { toLongPath } from '../paths/winLong.js';

/**
 * Startup reconciliation.
 *
 * Safety properties this enforces:
 *
 *  1. Any run with status='running' at startup is from a prior process that
 *     died. Mark them 'crashed' so a fresh start has a clean slate.
 *
 *  2. Any quarantine_action with planned_at set but executed_at IS NULL was
 *     inserted before the rename. We resolve each by inspecting the actual fs:
 *
 *       - dest present + size matches + sha256 matches  → mark executed (rename
 *         had completed; only the executed_at write was lost).
 *       - dest present + size or sha mismatch           → mark error (partial
 *         write or wrong file at dest); never set executed_at.
 *       - dest missing + src present                    → mark error (rename
 *         never started; a future quarantine pass can re-plan it from a fresh
 *         hash).
 *       - dest missing + src missing                    → mark error (state
 *         unknown; needs human review).
 *
 *     Design choice: reconcile NEVER renames or rehashes-then-renames. New fs
 *     operations require a new run, where the standard re-verify-before-move
 *     gate runs. Reconcile only updates book-keeping.
 *
 *     Verification at reconcile time honors the same invariant the mover
 *     uses on the happy path (post-move size + hash check). A partial dest
 *     file from an interrupted rename will not be marked executed.
 */
export interface ReconcileSummary {
  crashedRuns: number;
  pendingActionsResolved: number;
  pendingActionsErrored: number;
}

export function reconcilePending(db: Db, targetRoot: string): ReconcileSummary {
  let crashedRuns = 0;
  let pendingActionsResolved = 0;
  let pendingActionsErrored = 0;

  for (const run of findRunningRuns(db)) {
    setRunStatus(db, run.id, 'crashed');
    crashedRuns += 1;
  }

  const collectionsById = new Map<number, CollectionRow>();
  for (const c of listCollections(db)) collectionsById.set(c.id, c);

  for (const action of getPendingActions(db)) {
    const destStat = safeStatLeaf(action.dest_abs_path);

    if (destStat) {
      // Size check first; cheap reject before hashing.
      if (destStat.size !== action.size) {
        markActionError(
          db,
          action.id,
          `reconcile: dest size mismatch (expected ${action.size}, got ${destStat.size})`,
        );
        pendingActionsErrored += 1;
        continue;
      }
      // Hash check if we recorded one. (Cruft files may have null sha256 — for
      // those, size match is the strongest signal we have.)
      if (action.sha256_hex) {
        let fresh: string;
        try {
          fresh = hashFileSync(action.dest_abs_path);
        } catch (err) {
          markActionError(
            db,
            action.id,
            `reconcile: dest re-hash failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          pendingActionsErrored += 1;
          continue;
        }
        if (fresh !== action.sha256_hex) {
          markActionError(
            db,
            action.id,
            `reconcile: dest hash mismatch (expected ${action.sha256_hex}, got ${fresh})`,
          );
          pendingActionsErrored += 1;
          continue;
        }
      }
      markActionExecuted(db, action.id);
      pendingActionsResolved += 1;
      continue;
    }

    // dest is missing — check src to distinguish "rename never started" from
    // "both gone." Either way, leave executed_at NULL; a future quarantine
    // pass will re-plan.
    const collection = collectionsById.get(action.collection_id);
    let reason = 'reconcile: dest missing';
    if (collection) {
      const srcAbs = path.join(
        targetRoot,
        collection.rel_path,
        fromDbRelPath(action.src_rel_path),
      );
      reason = safeStatLeaf(srcAbs)
        ? 'reconcile: dest missing, src still present (rename never started)'
        : 'reconcile: dest and src both missing (state unknown)';
    }
    markActionError(db, action.id, reason);
    pendingActionsErrored += 1;
  }

  if (crashedRuns + pendingActionsResolved + pendingActionsErrored > 0) {
    appendAudit(targetRoot, 'reconcile', {
      crashedRuns,
      pendingActionsResolved,
      pendingActionsErrored,
    });
  }
  return { crashedRuns, pendingActionsResolved, pendingActionsErrored };
}

interface MinimalStat {
  size: number;
}

function safeStatLeaf(absPath: string): MinimalStat | null {
  try {
    const s = fs.lstatSync(toLongPath(absPath));
    if (!s.isFile()) return null;
    return { size: s.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
