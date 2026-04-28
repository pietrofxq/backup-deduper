import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb } from '../../src/db/index.js';
import {
  scanAll,
  syncCollectionsTable,
  UnreadableSubtreeError,
} from '../../src/scanner/index.js';
import {
  createRun,
  listAllLiveFiles,
  setRunStatus,
} from '../../src/db/queries.js';
import { walkCollection } from '../../src/scanner/walker.js';

/**
 * Linux/macOS only: chmod 000 actually denies read on POSIX. On Windows
 * the equivalent is harder to set up reliably and the user's own process
 * usually still has access regardless. Skip on win32 and on root.
 */
const isPosix = process.platform !== 'win32';
const isRoot = isPosix && process.getuid?.() === 0;
const skipIf = isPosix && !isRoot ? describe : describe.skip;

skipIf('walker — unreadable subtree handling (POSIX only)', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('unreadable-');
  });
  afterEach(() => {
    // Restore perms before rmRf so cleanup can recurse.
    try {
      fs.chmodSync(path.join(root, 'Backup-A', 'locked'), 0o755);
    } catch {
      /* may not exist */
    }
    rmRf(root);
  });

  it('walkCollection records EACCES dirs with kind="unreadable"', async () => {
    buildTree(root, {
      'Backup-A/visible.txt': 'hello',
      'Backup-A/locked/secret.txt': 'nope',
    });
    fs.chmodSync(path.join(root, 'Backup-A', 'locked'), 0o000);

    const walk = await walkCollection(path.join(root, 'Backup-A'));
    const unreadable = walk.errors.filter((e) => e.kind === 'unreadable');
    expect(unreadable.length).toBeGreaterThanOrEqual(1);
    expect(unreadable[0]?.absPath).toContain('locked');
  });

  it('scanAll throws UnreadableSubtreeError; previously-indexed rows are NOT deleted', async () => {
    buildTree(root, {
      'Backup-A/visible.txt': 'hello',
      'Backup-A/locked/secret.txt': 'nope',
    });
    await boot({ targetRoot: root, noServe: true });

    // First scan with everything readable: rows are persisted.
    const db = openDb(root);
    syncCollectionsTable(db, root);
    const runId1 = createRun(db, 'scan', true, {});
    const summary1 = await scanAll(db, root, runId1);
    setRunStatus(db, runId1, 'completed');
    expect(summary1.totalFiles).toBe(2);
    expect(listAllLiveFiles(db).length).toBe(2);

    // Now lock the subtree and re-scan.
    fs.chmodSync(path.join(root, 'Backup-A', 'locked'), 0o000);
    const runId2 = createRun(db, 'scan', true, {});
    await expect(scanAll(db, root, runId2)).rejects.toBeInstanceOf(UnreadableSubtreeError);
    setRunStatus(db, runId2, 'failed');

    // The previously-indexed rows MUST still be present — silent forgetting
    // is the bug this whole test exists to prevent.
    expect(listAllLiveFiles(db).length).toBe(2);
    db.client.close();
  });
});
