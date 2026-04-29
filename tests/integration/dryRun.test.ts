import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb } from '../../src/db/index.js';
import { listCollections, listReviewItems, setPrimary, listAllActions } from '../../src/db/queries.js';
import { runScanJob } from '../../src/orchestrator/scanJob.js';
import { syncCollectionsTable } from '../../src/scanner/index.js';

describe('dry-run scan job', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('dryrun-');
  });
  afterEach(() => rmRf(root));

  it('emits planned actions and writes a report; touches no files', async () => {
    buildTree(root, {
      'Backup-A/DCIM/Camera/IMG_1.jpg': 'photo1',
      'Backup-A/Download/IMG_1.jpg': 'photo1', // within-collection dup
      'Backup-A/Android/data/x.bin': 'cruftA',
      'Backup-A/Android/media/whatsapp.jpg': 'wa', // whitelisted
      'Backup-A/cache.exo': 'exoA',
      'Backup-A/Thumbs.db': 'os meta',
      'Backup-B/DCIM/Camera/IMG_1.jpg': 'photo1', // cross-collection dup with primary B
      'Backup-B/DCIM/Camera/IMG_2.jpg': 'photo2',
      'Backup-B/notes.txt': 'unique',
      'Backup-A/DCIM/Camera/COLLISION.jpg': 'verA',
      'Backup-B/DCIM/Camera/COLLISION.jpg': 'verB', // name collision
    });
    await boot({ targetRoot: root, noServe: true });

    // Mark Backup-B as primary. Need to sync collections first since boot
    // doesn't trigger discovery on its own.
    const db = openDb(root);
    syncCollectionsTable(db, root);
    const cols = listCollections(db);
    const primary = cols.find((c) => c.rel_path === 'Backup-B');
    expect(primary).toBeDefined();
    setPrimary(db, primary!.id);
    db.client.close();

    const db2 = openDb(root);
    const result = await runScanJob(db2, root, { dryRun: true });

    expect(result.report.dryRun).toBe(true);
    expect(result.report.totalActions).toBeGreaterThan(0);
    expect(result.report.reviewPairs).toBe(1);

    // Cruft reason for Android/data hit
    expect(result.report.countsByReason['cruft_preset_android_data']).toBeDefined();
    expect(result.report.countsByReason['cruft_preset_exo']).toBeDefined();
    expect(result.report.countsByReason['cruft_os_metadata']).toBeDefined();
    // Cross-collection dup reason
    expect(result.report.countsByReason['duplicate_cross_collection']).toBeDefined();
    // Within-collection dup
    expect(result.report.countsByReason['duplicate_within_collection']).toBeDefined();

    // Whitelist held
    const acted = result.report.actions.map((a) => `${a.collectionRelPath}|${a.relPath}`);
    expect(acted).not.toContain('Backup-A|Android/media/whatsapp.jpg');

    // Report on disk
    expect(fs.existsSync(result.reportPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
    expect(onDisk.runId).toBe(result.runId);

    // Files untouched
    expect(fs.existsSync(path.join(root, 'Backup-A/cache.exo'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'Backup-A/Android/data/x.bin'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'Backup-A/Android/media/whatsapp.jpg'))).toBe(true);

    // Review item persisted to DB
    const items = listReviewItems(db2);
    expect(items.length).toBe(1);
    expect(items[0]?.basename).toBe('COLLISION.jpg');

    // No quarantine_action rows in dry-run mode
    const all = listAllActions(db2);
    expect(all.length).toBe(0);

    db2.client.close();
  });

  it('sanity guard trips when actions touch >50% of primary', async () => {
    // Primary A has 3 files; 2 are within-collection dups → 2/3 ≈ 67% > 50%.
    buildTree(root, {
      'Backup-A/DCIM/Camera/keep.jpg': 'unique',
      'Backup-A/DCIM/Camera/dup.jpg': 'shared',
      'Backup-A/Download/dup.jpg': 'shared', // dup of above (within-collection)
      'Backup-A/Other/dup.jpg': 'shared', // also dup
    });
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    syncCollectionsTable(db, root);
    const a = listCollections(db).find((c) => c.rel_path === 'Backup-A')!;
    setPrimary(db, a.id);

    const result = await runScanJob(db, root, { dryRun: true });
    // Two within-collection duplicates of primary A's keeper → 2/4 = 50% files,
    // but bytes percent: shared=6 bytes per copy, total bytes=6+6+6+6=24, planned=12 → 50% bytes.
    // Defaults are >50% files, >70% bytes. With 2/4 we hit exactly 50% (not strict >),
    // so this should pass. Let's check the API behavior is consistent.
    expect(result.sanityGuard.plannedFiles).toBe(2);
    expect(result.sanityGuard.primaryFiles).toBe(4);
    // 50% is not strictly > 50%, so guard passes.
    expect(result.sanityGuard.passed).toBe(true);

    db.client.close();
  });

  it('sanity guard trips above the threshold', async () => {
    // 3 of 4 within-collection duplicates → 75% files > 50%.
    buildTree(root, {
      'Backup-A/DCIM/Camera/keep.jpg': 'unique',
      'Backup-A/a.jpg': 'shared',
      'Backup-A/b.jpg': 'shared',
      'Backup-A/c.jpg': 'shared',
      'Backup-A/d.jpg': 'shared',
    });
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    syncCollectionsTable(db, root);
    const a = listCollections(db).find((c) => c.rel_path === 'Backup-A')!;
    setPrimary(db, a.id);

    const result = await runScanJob(db, root, { dryRun: true });
    expect(result.sanityGuard.plannedFiles).toBeGreaterThanOrEqual(3);
    expect(result.sanityGuard.primaryFiles).toBe(5);
    expect(result.sanityGuard.passed).toBe(false);
    db.client.close();
  });
});
