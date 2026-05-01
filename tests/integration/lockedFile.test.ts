import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
 * Locked-file behaviour on Windows. Filling the M4 test gap.
 *
 * When another process holds the source file open with `Share=None`,
 * `fs.renameSync` raises EBUSY/EPERM. The mover must record the action
 * with an `error` value, leave the source file in place, and continue
 * the run — *not* throw out of the loop.
 *
 * IMPORTANT: Node's `fs.openSync` on Windows uses `FILE_SHARE_DELETE` by
 * default, which does NOT block rename. To get a real exclusive lock we
 * spawn a PowerShell child that opens the file with `[System.IO.File]::Open(
 * path, 'Open', 'Read', 'None')`. The child writes "READY" to stdout once
 * the lock is held, then blocks on stdin so the lock survives the test
 * window. Killing the process releases the lock.
 *
 * On POSIX, file locks are advisory and `rename` succeeds against an open
 * fd, so this test is meaningless. Skip on non-win32 so Linux/macOS CI
 * doesn't fake a behaviour the platform doesn't have.
 */
describe.skipIf(!isWindows)('quarantine — Windows-only locked-file handling', () => {
  let root: string;
  let locker: ChildProcessWithoutNullStreams | null = null;

  function lockFile(absPath: string): Promise<ChildProcessWithoutNullStreams> {
    return new Promise((resolve, reject) => {
      // PowerShell single-quoted strings need '' as escape for embedded '.
      const psPath = absPath.replace(/'/g, "''");
      const script =
        `$f = [System.IO.File]::Open('${psPath}', ` +
        `[System.IO.FileMode]::Open, ` +
        `[System.IO.FileAccess]::Read, ` +
        `[System.IO.FileShare]::None); ` +
        `Write-Host 'READY'; ` +
        `[Console]::In.ReadLine() | Out-Null; ` +
        `$f.Close();`;
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.kill();
          reject(new Error('timed out waiting for lock READY signal'));
        }
      }, 5000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (!resolved && chunk.toString().includes('READY')) {
          resolved = true;
          clearTimeout(timer);
          resolve(child);
        }
      });
      child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(err);
        }
      });
      child.on('exit', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new Error(`locker exited early with code ${code}`));
        }
      });
    });
  }

  beforeEach(() => {
    root = makeTmpDir('locked-');
  });
  afterEach(async () => {
    if (locker) {
      try {
        locker.kill();
      } catch {
        /* ignore */
      }
      locker = null;
      // Brief wait so Windows actually releases the handle before rmRf.
      await new Promise((r) => setTimeout(r, 200));
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

      // The non-primary collection's photo will be the action source.
      const victim = path.join(root, 'Backup-A', 'DCIM', 'Camera', 'IMG_1.jpg');
      locker = await lockFile(victim);

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
