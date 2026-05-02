import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb } from '../../src/db/index.js';
import {
  listActiveActions,
  listAllActions,
  listAllLiveFiles,
  listCollections,
  setPrimary,
} from '../../src/db/queries.js';
import { runScanJob } from '../../src/orchestrator/scanJob.js';
import {
  disableDryRun,
  DryRunGateError,
  runQuarantineJob,
  SanityGuardError,
} from '../../src/orchestrator/quarantineJob.js';
import { syncCollectionsTable } from '../../src/scanner/index.js';

describe('quarantine — two-phase commit happy path', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('quarantine-');
  });
  afterEach(() => rmRf(root));

  async function setupTwoCollectionsWithDup() {
    buildTree(root, {
      'Backup-A/DCIM/Camera/IMG_1.jpg': 'photo1',
      'Backup-A/Download/x.txt': 'unique-A',
      'Backup-B/DCIM/Camera/IMG_1.jpg': 'photo1', // dup of A
      'Backup-B/Download/y.txt': 'unique-B',
    });
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    syncCollectionsTable(db, root);
    const primary = listCollections(db).find((c) => c.rel_path === 'Backup-B')!;
    setPrimary(db, primary.id);
    return db;
  }

  it('refuses quarantine while dry_run is enabled (default)', async () => {
    const db = await setupTwoCollectionsWithDup();
    const scan = await runScanJob(db, root, { dryRun: true });
    expect(() =>
      runQuarantineJob({
        db,
        targetRoot: root,
        scanRunId: scan.runId,
        actions: scan.actions,
        emptyDirs: scan.emptyDirActions,
      }),
    ).toThrow(DryRunGateError);
    db.client.close();
  });

  it('quarantines duplicates after dry-run is disabled', async () => {
    const db = await setupTwoCollectionsWithDup();
    const scan = await runScanJob(db, root, { dryRun: true });
    expect(scan.actions.length).toBeGreaterThan(0);

    disableDryRun(db, 'I have reviewed the dry-run report', root);

    const result = runQuarantineJob({
      db,
      targetRoot: root,
      scanRunId: scan.runId,
      actions: scan.actions,
      emptyDirs: scan.emptyDirActions,
    });
    expect(result.summary.executed).toBe(scan.actions.length);
    expect(result.summary.errored).toBe(0);

    // Source of the loser is gone; primary copy still exists.
    expect(fs.existsSync(path.join(root, 'Backup-A/DCIM/Camera/IMG_1.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'Backup-B/DCIM/Camera/IMG_1.jpg'))).toBe(true);

    // Quarantine destination exists somewhere under .dedupe-trash/
    const trashDir = path.join(root, '.dedupe-trash');
    const quarantined = walk(trashDir).find((p) => p.endsWith('IMG_1.jpg'));
    expect(quarantined).toBeDefined();

    // Action row recorded with executed_at + verified_at.
    const actions = listAllActions(db);
    expect(actions).toHaveLength(scan.actions.length);
    expect(actions[0]?.executed_at).toBeTruthy();
    expect(actions[0]?.verified_at).toBeTruthy();

    // Live file row for the loser is gone from `file`.
    const live = listAllLiveFiles(db);
    expect(live.find((f) => f.rel_path === 'DCIM/Camera/IMG_1.jpg' && f.collection_id === 1)).toBeUndefined();
    db.client.close();
  });

  it('refuses if the file content changed between classify and move', async () => {
    const db = await setupTwoCollectionsWithDup();
    const scan = await runScanJob(db, root, { dryRun: true });
    disableDryRun(db, 'I have reviewed the dry-run report', root);

    // Mutate a file that's about to be quarantined — the loser at Backup-A.
    const racePath = path.join(root, 'Backup-A/DCIM/Camera/IMG_1.jpg');
    fs.writeFileSync(racePath, 'mutated-content-different-hash');

    const result = runQuarantineJob({
      db,
      targetRoot: root,
      scanRunId: scan.runId,
      actions: scan.actions,
      emptyDirs: scan.emptyDirActions,
    });
    // The file was protected by re-hash check.
    expect(result.summary.skippedHashMismatch).toBe(1);
    expect(fs.existsSync(racePath)).toBe(true);
    db.client.close();
  });

  it('sanity guard refuses when too much of primary would move', async () => {
    buildTree(root, {
      'Backup-A/keep.txt': 'unique',
      'Backup-A/a.txt': 'shared',
      'Backup-A/b.txt': 'shared',
      'Backup-A/c.txt': 'shared',
      'Backup-A/d.txt': 'shared',
    });
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    syncCollectionsTable(db, root);
    const a = listCollections(db).find((c) => c.rel_path === 'Backup-A')!;
    setPrimary(db, a.id);
    const scan = await runScanJob(db, root, { dryRun: true });
    expect(scan.sanityGuard.passed).toBe(false);
    expect(scan.sanityGuard.code).toBe('pct_exceeded');

    disableDryRun(db, 'I have reviewed the dry-run report', root);
    expect(() =>
      runQuarantineJob({
        db,
        targetRoot: root,
        scanRunId: scan.runId,
        actions: scan.actions,
        emptyDirs: scan.emptyDirActions,
      }),
    ).toThrow(SanityGuardError);

    // Override flag bypasses.
    const result = runQuarantineJob({
      db,
      targetRoot: root,
      scanRunId: scan.runId,
      actions: scan.actions,
      emptyDirs: scan.emptyDirActions,
      ignoreSanityGuard: true,
    });
    expect(result.summary.executed).toBeGreaterThan(0);
    db.client.close();
  });

  it('M15 — sanity guard fails closed when no primary is set and actions are non-empty', async () => {
    // Two collections, identical file content in both. With no primary, the
    // dedup tiebreak still emits a duplicate_cross_collection action — this
    // is the dangerous shape SG-1 / M15 fixed.
    buildTree(root, {
      'Backup-A/photo.jpg': 'photo',
      'Backup-B/photo.jpg': 'photo',
    });
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    syncCollectionsTable(db, root);
    // Deliberately do NOT call setPrimary.
    const scan = await runScanJob(db, root, { dryRun: true });
    expect(scan.actions.length).toBeGreaterThan(0);
    expect(scan.sanityGuard.passed).toBe(false);
    expect(scan.sanityGuard.code).toBe('no_primary_set');
    expect(scan.sanityGuard.reason).toMatch(/no primary collection set/i);

    // Disabling dry-run does NOT defeat the guard — it must still refuse.
    disableDryRun(db, 'I have reviewed the dry-run report', root);
    let thrown: unknown = null;
    try {
      runQuarantineJob({
        db,
        targetRoot: root,
        scanRunId: scan.runId,
        actions: scan.actions,
        emptyDirs: scan.emptyDirActions,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SanityGuardError);
    expect((thrown as SanityGuardError).guard.code).toBe('no_primary_set');
    db.client.close();
  });

  it('M15 — refuses a STALE plan from a no-primary scan even after a primary is selected', async () => {
    // Regression for Copilot review on PR #6 (stale-plan attack):
    //
    //   1. User scans with no primary set.
    //   2. classifier emits actions based on lex tiebreak (no anchor).
    //   3. User notices, marks one collection primary.
    //   4. User calls /quarantine/run with the SAME scanRunId.
    //
    // The cached actions list still reflects the lex-tiebroken plan, but
    // recomputing checkSanityGuard against the new DB state would now see
    // the primary set and pass — masking the fact that the plan itself is
    // tainted. runQuarantineJob must refuse based on the scan-time guard
    // (`scanGuard: cached.sanityGuard`), regardless of current primary.
    buildTree(root, {
      'Backup-A/photo.jpg': 'photo',
      'Backup-B/photo.jpg': 'photo',
    });
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    syncCollectionsTable(db, root);
    // Step 1: scan with NO primary set.
    const scan = await runScanJob(db, root, { dryRun: true });
    expect(scan.sanityGuard.code).toBe('no_primary_set');

    // Step 2: now mark a primary (post-scan).
    const a = listCollections(db).find((c) => c.rel_path === 'Backup-A')!;
    setPrimary(db, a.id);

    disableDryRun(db, 'I have reviewed the dry-run report', root);

    // Step 3: with scanGuard wired through (mimics the route), the job
    // refuses despite the recomputed guard now passing.
    let thrown: unknown = null;
    try {
      runQuarantineJob({
        db,
        targetRoot: root,
        scanRunId: scan.runId,
        actions: scan.actions,
        emptyDirs: scan.emptyDirActions,
        scanPrimaryId: scan.scanPrimaryId,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SanityGuardError);
    expect((thrown as SanityGuardError).guard.code).toBe('no_primary_set');
    expect((thrown as SanityGuardError).message).toMatch(/stale|re-?scan|cached/i);

    // The override flag still bypasses (escape hatch for advanced users).
    const result = runQuarantineJob({
      db,
      targetRoot: root,
      scanRunId: scan.runId,
      actions: scan.actions,
      emptyDirs: scan.emptyDirActions,
      scanGuard: scan.sanityGuard,
      ignoreSanityGuard: true,
    });
    expect(result.summary.executed).toBeGreaterThanOrEqual(0);
    db.client.close();
  });

  it('M15 round-3 — refuses a stale plan when the primary is SWITCHED between scan and apply', async () => {
    // Regression for review on PR #6: even when the scan was taken WITH
    // a primary set, switching primary before /quarantine/run still
    // leaves the cached actions stale — they were chosen relative to the
    // old primary's path priority and the cross-collection primary-wins
    // rule. The recomputed pct guard cannot catch this on its own
    // because it runs against the *new* primary's footprint.
    buildTree(root, {
      'Backup-A/photo.jpg': 'photo',
      'Backup-B/photo.jpg': 'photo',
    });
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    syncCollectionsTable(db, root);
    const a = listCollections(db).find((c) => c.rel_path === 'Backup-A')!;
    const b = listCollections(db).find((c) => c.rel_path === 'Backup-B')!;

    // Step 1: scan with Backup-A primary.
    setPrimary(db, a.id);
    const scan = await runScanJob(db, root, { dryRun: true });
    expect(scan.scanPrimaryId).toBe(a.id);
    expect(scan.sanityGuard.passed).toBe(true);
    expect(scan.actions.length).toBeGreaterThan(0);

    // Step 2: user switches primary to Backup-B.
    setPrimary(db, b.id);

    disableDryRun(db, 'I have reviewed the dry-run report', root);

    // Step 3: applying the cached plan must refuse with primary_changed.
    let thrown: unknown = null;
    try {
      runQuarantineJob({
        db,
        targetRoot: root,
        scanRunId: scan.runId,
        actions: scan.actions,
        emptyDirs: scan.emptyDirActions,
        scanPrimaryId: scan.scanPrimaryId,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SanityGuardError);
    const guardErr = thrown as SanityGuardError;
    expect(guardErr.guard.code).toBe('primary_changed');
    expect(guardErr.message).toMatch(/primary collection changed|rescan/i);

    // Override flag still bypasses (advanced-user escape hatch).
    const result = runQuarantineJob({
      db,
      targetRoot: root,
      scanRunId: scan.runId,
      actions: scan.actions,
      emptyDirs: scan.emptyDirActions,
      scanPrimaryId: scan.scanPrimaryId,
      ignoreSanityGuard: true,
    });
    expect(result.summary.executed).toBeGreaterThanOrEqual(0);
    db.client.close();
  });

  it('removes empty folders left behind by quarantine sweeps', async () => {
    buildTree(root, {
      'Backup-A/keep/a.txt': 'unique',
      'Backup-A/EmptyFolder/.gitkeep': 'x',
      'Backup-B/keep/a.txt': 'unique', // primary owns its own copy
    });
    fs.unlinkSync(path.join(root, 'Backup-A/EmptyFolder/.gitkeep'));
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    syncCollectionsTable(db, root);
    const primary = listCollections(db).find((c) => c.rel_path === 'Backup-B')!;
    setPrimary(db, primary.id);
    const scan = await runScanJob(db, root, { dryRun: true });
    disableDryRun(db, 'I have reviewed the dry-run report', root);
    const result = runQuarantineJob({
      db,
      targetRoot: root,
      scanRunId: scan.runId,
      actions: scan.actions,
      emptyDirs: scan.emptyDirActions,
    });
    expect(result.summary.emptyDirsRemoved).toBe(1);
    expect(fs.existsSync(path.join(root, 'Backup-A/EmptyFolder'))).toBe(false);
    db.client.close();
  });

  it('listActiveActions reflects the quarantined files', async () => {
    const db = await setupTwoCollectionsWithDup();
    const scan = await runScanJob(db, root, { dryRun: true });
    disableDryRun(db, 'I have reviewed the dry-run report', root);
    const result = runQuarantineJob({
      db,
      targetRoot: root,
      scanRunId: scan.runId,
      actions: scan.actions,
      emptyDirs: scan.emptyDirActions,
    });
    const active = listActiveActions(db, result.runId);
    expect(active.length).toBe(scan.actions.length);
    db.client.close();
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(abs);
      else out.push(abs);
    }
  }
  return out;
}
