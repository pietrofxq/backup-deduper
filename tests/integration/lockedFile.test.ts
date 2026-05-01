import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb } from '../../src/db/index.js';
import { listAllActions, listCollections, setPrimary } from '../../src/db/queries.js';
import { runScanJob } from '../../src/orchestrator/scanJob.js';
import { disableDryRun, runQuarantineJob } from '../../src/orchestrator/quarantineJob.js';
import { syncCollectionsTable } from '../../src/scanner/index.js';

const isWindows = process.platform === 'win32';

/**
 * Locked-file behaviour on Windows. Filling the M4 test gap:
 *
 * When the user has another process holding the source file open with an
 * exclusive read lock, `fs.renameSync` raises EBUSY/EPERM. The mover must
 * record the action with an `error` value, leave the source file in place,
 * and continue the run — *not* throw out of the loop.
 *
 * On POSIX, file locks are advisory and `rename` succeeds against an open
 * fd, so this test is meaningless. Skip on non-win32 so Linux/macOS CI
 * doesn't fake a behaviour the platform doesn't have.
 */
describe.skipIf(!isWindows)('quarantine — Windows-only locked-file handling', () => {
  let root: string;
  let lockedFd: number | null = null;
  beforeEach(() => {
    root = makeTmpDir('locked-');
  });
  afterEach(() => {
    if (lockedFd !== null) {
      try {
        fs.closeSync(lockedFd);
      } catch {
        /* ignore */
      }
      lockedFd = null;
    }
    rmRf(root);
  });

  it('records an error and continues when the source file is locked', async () => {
    buildTree(root, {
      'Backup-A/DCIM/Camera/IMG_1.jpg': 'photo1',
      'Backup-B/DCIM/Camera/IMG_1.jpg': 'photo1', // duplicate of A
      'Backup-B/Download/y.txt': 'unique-B',
    });
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    try {
      syncCollectionsTable(db, root);
      const primary = listCollections(db).find((c) => c.rel_path === 'Backup-B')!;
      setPrimary(db, primary.id);

      const scan = await runScanJob(db, root, { dryRun: true });
      disableDryRun(db, 'I have reviewed the dry-run report', root);

      // Hold an exclusive lock on the planned-quarantine source.
      const victim = path.join(root, 'Backup-A', 'DCIM', 'Camera', 'IMG_1.jpg');
      lockedFd = fs.openSync(victim, 'r+');

      const result = runQuarantineJob({
        db,
        targetRoot: root,
        scanRunId: scan.runId,
        actions: scan.actions,
        emptyDirs: scan.emptyDirActions,
      });
      // The locked file's action must be in the errored count, not silently skipped.
      expect(result.summary.errored).toBeGreaterThanOrEqual(1);
      const all = listAllActions(db, result.runId);
      const errored = all.filter((a) => a.error !== null);
      expect(errored.length).toBeGreaterThanOrEqual(1);
      // The source must still exist on disk (the rename failed).
      expect(fs.existsSync(victim)).toBe(true);
    } finally {
      db.client.close();
    }
  });
});
