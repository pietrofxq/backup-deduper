import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb } from '../../src/db/index.js';
import { listActiveActions, listAllActions, listCollections, setPrimary } from '../../src/db/queries.js';
import { runScanJob } from '../../src/orchestrator/scanJob.js';
import { disableDryRun, runQuarantineJob } from '../../src/orchestrator/quarantineJob.js';
import { purge } from '../../src/mover/purge.js';
import { syncCollectionsTable } from '../../src/scanner/index.js';

describe('purge', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('purge-');
  });
  afterEach(() => rmRf(root));

  async function setupQuarantined() {
    buildTree(root, {
      'Backup-A/photo.jpg': 'photo-bytes',
      'Backup-B/photo.jpg': 'photo-bytes',
    });
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    syncCollectionsTable(db, root);
    setPrimary(db, listCollections(db).find((c) => c.rel_path === 'Backup-B')!.id);
    const scan = await runScanJob(db, root, { dryRun: true });
    disableDryRun(db, 'I have reviewed the dry-run report', root);
    runQuarantineJob({
      db,
      targetRoot: root,
      scanRunId: scan.runId,
      actions: scan.actions,
      emptyDirs: scan.emptyDirActions,
    });
    return db;
  }

  it('refuses to purge actions that are too young', async () => {
    const db = await setupQuarantined();
    const before = listActiveActions(db);
    expect(before.length).toBe(1);

    const summary = purge({ db, targetRoot: root, retentionDays: 30, dryRun: false });
    expect(summary.eligible).toBe(0);
    expect(summary.purgedFiles).toBe(0);
    expect(fs.existsSync(before[0]!.dest_abs_path)).toBe(true);
    db.client.close();
  });

  it('purges actions older than retention window (dryRun reports counts; no fs changes)', async () => {
    const db = await setupQuarantined();
    const before = listActiveActions(db);
    const action = before[0]!;
    const future = new Date(Date.now() + 60 * 86_400_000);

    const dry = purge({ db, targetRoot: root, retentionDays: 30, dryRun: true, now: future });
    expect(dry.eligible).toBe(1);
    expect(dry.purgedFiles).toBe(1);
    expect(fs.existsSync(action.dest_abs_path)).toBe(true);

    const real = purge({ db, targetRoot: root, retentionDays: 30, dryRun: false, now: future });
    expect(real.purgedFiles).toBe(1);
    expect(fs.existsSync(action.dest_abs_path)).toBe(false);

    const all = listAllActions(db);
    expect(all[0]?.purged_at).toBeTruthy();
    db.client.close();
  });

  it('refuses to purge a file whose dest_abs_path is outside the trash dir', async () => {
    const db = await setupQuarantined();
    // Plant a real file outside the trash dir (and outside target_root) so
    // we can verify purge refused to touch it without depending on any
    // OS-specific path. The previous version used /etc/passwd which would
    // not exist on Windows runners.
    const outsideRoot = makeTmpDir('outside-trash-');
    const outsideFile = path.join(outsideRoot, 'sentinel.txt');
    fs.writeFileSync(outsideFile, 'should-not-be-purged');

    try {
      db.client
        .prepare('UPDATE quarantine_action SET dest_abs_path = ? WHERE id = 1')
        .run(outsideFile);
      const future = new Date(Date.now() + 60 * 86_400_000);
      const summary = purge({
        db,
        targetRoot: root,
        retentionDays: 30,
        dryRun: false,
        now: future,
      });
      expect(summary.errored).toBe(1);
      expect(summary.purgedFiles).toBe(0);
      expect(fs.existsSync(outsideFile)).toBe(true);
    } finally {
      db.client.close();
      rmRf(outsideRoot);
    }
  });
});
