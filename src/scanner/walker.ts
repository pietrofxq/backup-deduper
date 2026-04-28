import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { toDbRelPath } from '../paths/relpath.js';

export interface WalkedFile {
  absPath: string;
  /** rel-path under collectionRoot, in DB form (forward slashes). */
  relPath: string;
  size: number;
  mtimeMs: number;
}

export interface WalkedDir {
  absPath: string;
  relPath: string;
  empty: boolean;
}

export interface WalkError {
  absPath: string;
  message: string;
  /**
   * Tagged 'unreadable' for permission-style failures the orchestrator must
   * treat as fatal: a single EACCES on a directory means fast-glob silently
   * dropped its entire subtree, and continuing the scan would let
   * deleteStaleFiles() forget previously-indexed rows under that dir.
   *
   * 'depth_warning' is informational only — the walk continues normally.
   */
  kind: 'unreadable' | 'depth_warning';
}

export interface WalkResult {
  files: WalkedFile[];
  emptyDirs: WalkedDir[];
  errors: WalkError[];
  rejectedSymlinks: string[];
  maxDepthSeen: number;
}

const DEPTH_WARN = 100;

/**
 * Collection walker built on fast-glob.
 *
 * Properties guaranteed:
 *   - Symlinks (file or dir) are explicitly rejected, never followed.
 *   - Empty-directory tracking: returns a list of directories whose subtree
 *     contains zero non-symlink regular files. These are candidates for the
 *     `cruft_empty_folder` rule.
 *   - Depth tracking: maxDepthSeen is reported; ≥100 produces a warning entry.
 *   - The fallback per-dir lstat for empty-dir candidates surfaces ENOENT-
 *     and stat-errors into `result.errors`; the depth warning lands there too.
 *
 * Limitation, flagged for M11: the underlying fast-glob calls use
 * `suppressErrors: true`, so per-file glob errors (EACCES, etc.) are
 * silently dropped instead of recorded. Re-enabling and capturing them
 * needs a streaming fast-glob call wired through an error event.
 */
export async function walkCollection(collectionRoot: string): Promise<WalkResult> {
  const result: WalkResult = {
    files: [],
    emptyDirs: [],
    errors: [],
    rejectedSymlinks: [],
    maxDepthSeen: 0,
  };

  if (!fs.existsSync(collectionRoot)) return result;

  // 0. Detect any unreadable subtree BEFORE we trust fast-glob's output.
  // fast-glob with suppressErrors:true silently drops subtrees on EACCES /
  // EPERM, which would let deleteStaleFiles() clear the rows for those
  // files in the DB. The orchestrator is expected to refuse the scan when
  // any 'unreadable' error is reported here.
  collectUnreadableDirs(collectionRoot, '', result);

  // 1. Walk files via fast-glob with stats. Symlinks are NOT followed.
  const fileEntries = await fg('**/*', {
    cwd: collectionRoot,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    stats: true,
    markDirectories: false,
    objectMode: true,
  });

  for (const entry of fileEntries) {
    if (!entry.stats) continue;
    if (entry.stats.isSymbolicLink()) {
      result.rejectedSymlinks.push(path.join(collectionRoot, entry.path));
      continue;
    }
    if (!entry.stats.isFile()) continue;
    const relForward = toDbRelPath(entry.path);
    const absPath = path.join(collectionRoot, entry.path);
    const depth = relForward === '' ? 0 : relForward.split('/').length;
    if (depth > result.maxDepthSeen) result.maxDepthSeen = depth;
    result.files.push({
      absPath,
      relPath: relForward,
      size: entry.stats.size,
      mtimeMs: Math.floor(entry.stats.mtimeMs),
    });
  }

  if (result.maxDepthSeen >= DEPTH_WARN) {
    result.errors.push({
      absPath: collectionRoot,
      message: `tree contains paths >= ${DEPTH_WARN} segments deep (warning)`,
      kind: 'depth_warning',
    });
  }

  // 2. Walk directories — needed to surface empty-folder cruft candidates.
  // fast-glob with markDirectories returns paths with a trailing `/`; we strip
  // it for the comparison.
  const dirEntries = await fg('**/', {
    cwd: collectionRoot,
    dot: true,
    onlyDirectories: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    markDirectories: true,
  });

  // Build a set of file-bearing dir prefixes (any ancestor of a file).
  const dirsWithFiles = new Set<string>();
  for (const f of result.files) {
    let cur = f.relPath;
    while (cur.includes('/')) {
      cur = cur.slice(0, cur.lastIndexOf('/'));
      dirsWithFiles.add(cur);
    }
    dirsWithFiles.add(''); // root always has files if any file exists
  }

  for (const dirRaw of dirEntries) {
    // Strip trailing slash and normalize to DB form.
    const trimmed = dirRaw.endsWith('/') ? dirRaw.slice(0, -1) : dirRaw;
    if (trimmed === '') continue;
    const dbRel = toDbRelPath(trimmed);
    if (dirsWithFiles.has(dbRel)) continue;

    // Confirm via lstat that the dir isn't a symlink. fast-glob with
    // followSymbolicLinks:false should already have skipped these.
    const abs = path.join(collectionRoot, trimmed);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(abs);
    } catch (err) {
      result.errors.push({
        absPath: abs,
        message: err instanceof Error ? err.message : String(err),
        kind: 'unreadable',
      });
      continue;
    }
    if (stat.isSymbolicLink()) {
      result.rejectedSymlinks.push(abs);
      continue;
    }

    result.emptyDirs.push({ absPath: abs, relPath: dbRel, empty: true });

    const depth = dbRel.split('/').length;
    if (depth > result.maxDepthSeen) result.maxDepthSeen = depth;
  }

  return result;
}

/**
 * Synchronous BFS over directories under `collectionRoot`, used purely to
 * surface subtrees we don't have permission to read. fast-glob is what
 * actually populates result.files; this pass exists ONLY to detect EACCES /
 * EPERM that fast-glob silently swallows.
 *
 * Why sync: this runs inline on the walker thread, the volume is local,
 * and the cost is one extra readdir per directory which is negligible
 * compared to fast-glob's own traversal. Mixing it into fast-glob via
 * stream events would require turning suppressErrors off and handling
 * spurious ENOENTs on files races, which is more error-prone than a
 * dedicated pass.
 */
function collectUnreadableDirs(
  collectionRoot: string,
  relSoFar: string,
  result: WalkResult,
): void {
  const queue: Array<{ abs: string; rel: string }> = [
    { abs: collectionRoot, rel: relSoFar },
  ];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur.abs, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        result.errors.push({
          absPath: cur.abs,
          message: `cannot read directory (${code}): ${cur.abs}`,
          kind: 'unreadable',
        });
      }
      // ENOENT (file disappeared mid-walk) and friends: skip silently —
      // fast-glob's behavior is the same and there's nothing actionable.
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow
      if (!e.isDirectory()) continue;
      const childAbs = path.join(cur.abs, e.name);
      queue.push({ abs: childAbs, rel: cur.rel ? `${cur.rel}/${e.name}` : e.name });
    }
  }
}
