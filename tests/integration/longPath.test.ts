import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, rmRf } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb } from '../../src/db/index.js';
import {
  listActiveActions,
  listCollections,
  setPrimary,
} from '../../src/db/queries.js';
import { runScanJob } from '../../src/orchestrator/scanJob.js';
import { disableDryRun, runQuarantineJob } from '../../src/orchestrator/quarantineJob.js';
import { syncCollectionsTable } from '../../src/scanner/index.js';
import { toLongPath } from '../../src/paths/winLong.js';

const isWindows = process.platform === 'win32';

/**
 * Long-path behaviour on Windows. Fills the M4 test gap by exercising a
 * 150-segment path past MAX_PATH. The walker, hasher, and mover must all
 * tolerate the `\\?\` prefix that `toLongPath` produces.
 *
 * Only meaningful on Windows; ext4/HFS+ have no MAX_PATH equivalent. Skip
 * outside win32 so Linux/macOS CI doesn't fake a Windows-specific concern.
 */
describe.skipIf(!isWindows)('quarantine — Windows-only long-path handling', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('longpath-');
  });
  afterEach(() => {
    // Use the long-path prefix on cleanup so the deep tree is reachable.
    try {
      rmRf(toLongPath(root));
    } catch {
      rmRf(root);
    }
  });

  it('walks, hashes, and quarantines through a path deeper than MAX_PATH', async () => {
    // Build "Backup-A/seg1/seg1/seg1/.../IMG_1.jpg" 150 segments deep, with
    // a duplicate at "Backup-B/IMG_1.jpg" that we expect to be quarantined.
    const segments = Array(150).fill('seg').join(path.sep);
    const deepDir = path.join(root, 'Backup-A', segments);
    fs.mkdirSync(toLongPath(deepDir), { recursive: true });
    fs.writeFileSync(toLongPath(path.join(deepDir, 'IMG_1.jpg')), 'photo1');

    const shallowDir = path.join(root, 'Backup-B');
    fs.mkdirSync(shallowDir, { recursive: true });
    fs.writeFileSync(path.join(shallowDir, 'IMG_1.jpg'), 'photo1');

    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    try {
      syncCollectionsTable(db, root);
      const primary = listCollections(db).find((c) => c.rel_path === 'Backup-B')!;
      setPrimary(db, primary.id);

      const scan = await runScanJob(db, root, { dryRun: true });
      // Scan should have hashed both files.
      expect(scan.report.scanSummary.totalFiles).toBeGreaterThanOrEqual(2);
      disableDryRun(db, 'I have reviewed the dry-run report', root);

      const result = runQuarantineJob({
        db,
        targetRoot: root,
        scanRunId: scan.runId,
        actions: scan.actions,
        emptyDirs: scan.emptyDirActions,
      });
      expect(result.summary.executed).toBeGreaterThanOrEqual(1);
      const active = listActiveActions(db, result.runId);
      expect(active.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.client.close();
    }
  });
});
