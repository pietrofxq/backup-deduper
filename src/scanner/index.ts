import path from 'node:path';
import fs from 'node:fs';
import type { Db } from '../db/index.js';
import { walkCollection, type WalkResult } from './walker.js';
import { HasherPool } from '../hasher/pool.js';
import {
  deleteStaleFiles,
  getFile,
  listCollections,
  setFileHash,
  upsertCollection,
  upsertFile,
} from '../db/queries.js';
import { DEDUPE_DIR_NAME, TRASH_DIR_NAME } from '../target/sentinel.js';

export class UnreadableSubtreeError extends Error {
  constructor(
    message: string,
    public readonly unreadablePaths: ReadonlyArray<string>,
    public readonly collectionRelPath: string,
  ) {
    super(message);
    this.name = 'UnreadableSubtreeError';
  }
}

export interface CollectionScanSummary {
  collectionId: number;
  collectionRelPath: string;
  filesSeen: number;
  filesHashed: number;
  filesCached: number;
  emptyDirs: number;
  errors: number;
  rejectedSymlinks: number;
}

export interface ScanSummary {
  runId: number;
  collections: CollectionScanSummary[];
  /** Per-collection empty directories (rel-paths in DB form). Transient; not stored in DB. */
  emptyDirsByCollection: Map<number, string[]>;
  totalFiles: number;
  totalHashed: number;
  totalCached: number;
  durationMs: number;
}

export interface ScanOptions {
  /** When set, only scan these collections (DB rel_path). Otherwise: scan all. */
  onlyCollections?: string[];
  /** Optional progress callback for SSE. */
  onProgress?: (event: ScanProgressEvent) => void;
}

export type ScanProgressEvent =
  | { type: 'discovered'; collection: string; files: number }
  | { type: 'hashed'; collection: string; relPath: string; index: number; total: number }
  | { type: 'collection_done'; summary: CollectionScanSummary };

/**
 * Discover top-level subdirectories under target_root that look like
 * collections. Filters out the tool's own folders (.dedupe, .dedupe-trash) and
 * dot-prefixed entries.
 */
export function discoverCollections(targetRoot: string): string[] {
  const entries = fs.readdirSync(targetRoot, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isDirectory() &&
        e.name !== DEDUPE_DIR_NAME &&
        e.name !== TRASH_DIR_NAME &&
        !e.name.startsWith('.'),
    )
    .map((e) => e.name)
    .sort();
}

/**
 * Sync the `collection` table to whatever is on disk under target_root.
 * Adds missing rows; never deletes (so a temporarily-detached subfolder doesn't
 * orphan its file rows).
 */
export function syncCollectionsTable(db: Db, targetRoot: string): void {
  for (const name of discoverCollections(targetRoot)) {
    upsertCollection(db, name);
  }
}

/** Top-level scan entrypoint. Caller owns the run row (created in orchestrator). */
export async function scanAll(
  db: Db,
  targetRoot: string,
  runId: number,
  opts: ScanOptions = {},
): Promise<ScanSummary> {
  const t0 = Date.now();
  syncCollectionsTable(db, targetRoot);

  const all = listCollections(db);
  const targets = opts.onlyCollections
    ? all.filter((c) => opts.onlyCollections!.includes(c.rel_path))
    : all;

  const pool = new HasherPool(1);
  const summaries: CollectionScanSummary[] = [];
  const emptyDirsByCollection = new Map<number, string[]>();
  try {
    for (const c of targets) {
      const r = await scanCollection(db, targetRoot, c.id, c.rel_path, runId, pool, opts);
      summaries.push(r.summary);
      emptyDirsByCollection.set(c.id, r.emptyDirRelPaths);
      opts.onProgress?.({ type: 'collection_done', summary: r.summary });
    }
  } finally {
    await pool.close();
  }

  // Files that weren't seen during this run (across all collections we scanned)
  // are deleted by `last_seen_run < runId`. We restrict via collection filter
  // when opts.onlyCollections is set so partial scans don't nuke siblings.
  let staleDeleted = 0;
  if (!opts.onlyCollections) {
    staleDeleted = deleteStaleFiles(db, runId);
  }
  void staleDeleted;

  return {
    runId,
    collections: summaries,
    emptyDirsByCollection,
    totalFiles: summaries.reduce((a, b) => a + b.filesSeen, 0),
    totalHashed: summaries.reduce((a, b) => a + b.filesHashed, 0),
    totalCached: summaries.reduce((a, b) => a + b.filesCached, 0),
    durationMs: Date.now() - t0,
  };
}

async function scanCollection(
  db: Db,
  targetRoot: string,
  collectionId: number,
  collectionRelPath: string,
  runId: number,
  pool: HasherPool,
  opts: ScanOptions,
): Promise<{ summary: CollectionScanSummary; emptyDirRelPaths: string[] }> {
  const collectionRoot = path.join(targetRoot, collectionRelPath);
  const walk: WalkResult = await walkCollection(collectionRoot);

  // Refuse if any subtree is unreadable. Continuing would let the
  // last_seen_run cleanup at end-of-scan delete the rows of files we
  // couldn't see — silently forgetting them. Caller (orchestrator) gets a
  // structured error so the user can fix permissions and re-scan.
  const unreadable = walk.errors
    .filter((e) => e.kind === 'unreadable')
    .map((e) => e.absPath);
  if (unreadable.length > 0) {
    throw new UnreadableSubtreeError(
      `cannot scan collection "${collectionRelPath}": ${unreadable.length} unreadable ` +
        `subtree(s) — fix permissions and re-scan. Affected: ${unreadable
          .slice(0, 5)
          .join(', ')}${unreadable.length > 5 ? '…' : ''}`,
      unreadable,
      collectionRelPath,
    );
  }

  opts.onProgress?.({
    type: 'discovered',
    collection: collectionRelPath,
    files: walk.files.length,
  });

  let filesHashed = 0;
  let filesCached = 0;

  // Cache key: (size, mtime_ms) per (collection_id, rel_path).
  // Unchanged → reuse. Changed → re-hash. Missing row → hash (new file).
  for (let i = 0; i < walk.files.length; i++) {
    const f = walk.files[i];
    if (!f) continue;
    const existing = getFile(db, collectionId, f.relPath);
    const cached =
      existing !== null &&
      existing.size === f.size &&
      existing.mtime_ms === f.mtimeMs &&
      existing.sha256_hex !== null;

    if (cached) {
      // Touch last_seen_run; keep hash.
      upsertFile(db, collectionId, f.relPath, f.size, f.mtimeMs, existing!.sha256_hex, runId);
      filesCached += 1;
      continue;
    }

    // Insert / update WITHOUT a hash first, then hash and update.
    // This way an interrupted scan can restart from the unhashed rows.
    upsertFile(db, collectionId, f.relPath, f.size, f.mtimeMs, null, runId);

    const result = await pool.hash({ absPath: f.absPath, cookie: i });
    if (result.sha256) {
      setFileHash(db, collectionId, f.relPath, result.sha256);
      filesHashed += 1;
      opts.onProgress?.({
        type: 'hashed',
        collection: collectionRelPath,
        relPath: f.relPath,
        index: i + 1,
        total: walk.files.length,
      });
    }
    // On error we leave sha256 NULL; classifier ignores files without a hash
    // for dedup purposes (they can still be cruft-classified).
  }

  return {
    summary: {
      collectionId,
      collectionRelPath,
      filesSeen: walk.files.length,
      filesHashed,
      filesCached,
      emptyDirs: walk.emptyDirs.length,
      errors: walk.errors.length,
      rejectedSymlinks: walk.rejectedSymlinks.length,
    },
    emptyDirRelPaths: walk.emptyDirs.map((d) => d.relPath),
  };
}
