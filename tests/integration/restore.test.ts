import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb } from '../../src/db/index.js';
import { listActiveActions, listCollections, setPrimary } from '../../src/db/queries.js';
import { runScanJob } from '../../src/orchestrator/scanJob.js';
import { disableDryRun, runQuarantineJob } from '../../src/orchestrator/quarantineJob.js';
import { bulkRestore, restoreOne } from '../../src/mover/restore.js';
import { hashFileSync } from '../../src/hasher/sha256.js';
import { syncCollectionsTable } from '../../src/scanner/index.js';

describe('restore', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('restore-');
  });
  afterEach(() => rmRf(root));

  async function setup() {
    buildTree(root, {
      'Backup-A/photo.jpg': 'photo-bytes',
      'Backup-B/photo.jpg': 'photo-bytes',
    });
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    syncCollectionsTable(db, root);
    const primary = listCollections(db).find((c) => c.rel_path === 'Backup-B')!;
    setPrimary(db, primary.id);
    const scan = await runScanJob(db, root, { dryRun: true });
    disableDryRun(db, 'I have reviewed the dry-run report', root);
    const q = runQuarantineJob({
      db,
      targetRoot: root,
      scanRunId: scan.runId,
      actions: scan.actions,
      emptyDirs: scan.emptyDirActions,
    });
    return { db, scan, q };
  }

  it('happy path: restored file matches original hash', async () => {
    const { db } = await setup();
    const active = listActiveActions(db);
    expect(active.length).toBe(1);
    const action = active[0]!;
    const expectedHash = action.sha256_hex!;

    const out = restoreOne(db, root, action.id, { allowSidecar: false });
    expect(out.kind).toBe('restored');

    const restoredPath = path.join(root, 'Backup-A/photo.jpg');
    expect(fs.existsSync(restoredPath)).toBe(true);
    expect(hashFileSync(restoredPath)).toBe(expectedHash);
    db.client.close();
  });

  it('refuses when target path occupied with different content (no sidecar opt)', async () => {
    const { db } = await setup();
    const action = listActiveActions(db)[0]!;

    fs.writeFileSync(path.join(root, 'Backup-A/photo.jpg'), 'different-content');
    const out = restoreOne(db, root, action.id, { allowSidecar: false });
    expect(out.kind).toBe('errored');
    db.client.close();
  });

  it('routes to sidecar when target occupied and allowSidecar set', async () => {
    const { db } = await setup();
    const action = listActiveActions(db)[0]!;
    fs.writeFileSync(path.join(root, 'Backup-A/photo.jpg'), 'different-content');
    const out = restoreOne(db, root, action.id, { allowSidecar: true });
    expect(out.kind).toBe('restored_sidecar');
    if (out.kind === 'restored_sidecar') {
      expect(fs.existsSync(out.finalPath)).toBe(true);
      expect(out.finalPath).toMatch(/\(restored\)\.jpg$/);
    }
    db.client.close();
  });

  it('skips silently when occupant has matching hash', async () => {
    const { db } = await setup();
    const action = listActiveActions(db)[0]!;
    // Re-place exact same content at the source path.
    fs.writeFileSync(path.join(root, 'Backup-A/photo.jpg'), 'photo-bytes');
    const out = restoreOne(db, root, action.id, { allowSidecar: false });
    expect(out.kind).toBe('restored');
    db.client.close();
  });

  it('bulkRestore restores all listed actions', async () => {
    buildTree(root, {
      'Backup-A/a.jpg': 'photo-a',
      'Backup-A/b.jpg': 'photo-b',
      'Backup-B/a.jpg': 'photo-a',
      'Backup-B/b.jpg': 'photo-b',
    });
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    syncCollectionsTable(db, root);
    setPrimary(db, listCollections(db).find((c) => c.rel_path === 'Backup-B')!.id);
    const scan = await runScanJob(db, root, { dryRun: true });
    disableDryRun(db, 'I have reviewed the dry-run report', root);
    const q = runQuarantineJob({
      db,
      targetRoot: root,
      scanRunId: scan.runId,
      actions: scan.actions,
      emptyDirs: scan.emptyDirActions,
    });
    const ids = listActiveActions(db, q.runId).map((a) => a.id);
    const r = bulkRestore({ db, targetRoot: root, actionIds: ids, allowSidecar: false });
    for (const o of r.outcomes) {
      expect(['restored', 'restored_sidecar']).toContain(o.outcome.kind);
    }
    expect(fs.existsSync(path.join(root, 'Backup-A/a.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'Backup-A/b.jpg'))).toBe(true);
    db.client.close();
  });

  it('refuses if dest_abs_path was tampered to point outside .dedupe-trash/', async () => {
    const { db } = await setup();
    const action = listActiveActions(db)[0]!;

    // Plant a file outside the trash and rewrite the action to point at it.
    // restoreOne would otherwise rename it into the live tree.
    const outsideRoot = makeTmpDir('outside-trash-');
    const outsideFile = path.join(outsideRoot, 'attacker.bin');
    fs.writeFileSync(outsideFile, 'photo-bytes'); // matches recorded hash
    db.client
      .prepare('UPDATE quarantine_action SET dest_abs_path = ? WHERE id = ?')
      .run(outsideFile, action.id);

    try {
      const out = restoreOne(db, root, action.id, { allowSidecar: false });
      expect(out.kind).toBe('errored');
      if (out.kind === 'errored') {
        expect(out.error).toMatch(/outside .dedupe-trash/);
      }
      // The planted file is untouched and the live tree wasn't modified.
      expect(fs.existsSync(outsideFile)).toBe(true);
      expect(fs.existsSync(path.join(root, 'Backup-A/photo.jpg'))).toBe(false);
    } finally {
      db.client.close();
      rmRf(outsideRoot);
    }
  });
});
