import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb } from '../../src/db/index.js';
import {
  getAction,
  insertPlannedAction,
  listActiveActions,
  listAllActions,
  listAllLiveFiles,
  listCollections,
  setPrimary,
  setRunStatus,
  upsertCollection,
  type QuarantineActionRow,
} from '../../src/db/queries.js';
import { runScanJob } from '../../src/orchestrator/scanJob.js';
import { disableDryRun, runQuarantineJob } from '../../src/orchestrator/quarantineJob.js';
import { syncCollectionsTable } from '../../src/scanner/index.js';
import { reconcilePending } from '../../src/mover/reconcile.js';
import { quarantineDestFor } from '../../src/mover/quarantine.js';
import { hashFileSync } from '../../src/hasher/sha256.js';

/**
 * Crash-recovery integration tests for the two-phase commit mover.
 *
 * The scenarios all revolve around what reconcilePending() does on the next
 * boot when it finds rows where executed_at IS NULL. The cases are:
 *   A. dest present, size + hash match → mark executed (rename completed,
 *      only the executed_at write was lost).
 *   B. dest present, size differs → mark error (partial write).
 *   C. dest present, hash differs → mark error (wrong file at dest).
 *   D. dest missing, src still present → mark error (rename never started).
 *   E. dest missing, src also missing → mark error (state unknown).
 *
 * No reconcile path may set executed_at without re-verifying the dest. That
 * is the safety property this file proves.
 */
describe('reconcile — crash recovery cases', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('reconcile-');
  });
  afterEach(() => rmRf(root));

  /** Boot, set primary, plant a fake "interrupted" run + planned action, return it. */
  async function setupInterrupted(args: {
    contents: string;
    placeDestAs?: string | 'matching' | 'omit';
    placeSrc?: 'present' | 'missing';
  }): Promise<{
    db: ReturnType<typeof openDb>;
    action: QuarantineActionRow;
    expectedHash: string;
    srcAbs: string;
    destAbs: string;
  }> {
    buildTree(root, {
      'Backup-A/photo.jpg': args.contents,
    });
    await boot({ targetRoot: root, noServe: true });

    const db = openDb(root);
    syncCollectionsTable(db, root);
    const collections = listCollections(db);
    const a = collections.find((c) => c.rel_path === 'Backup-A')!;
    setPrimary(db, a.id);

    const expectedHash = hashFileSync(path.join(root, 'Backup-A/photo.jpg'));

    // Create a "running" run — reconcile should mark it crashed.
    db.client
      .prepare(
        `INSERT INTO run (kind, status, dry_run, config_json) VALUES (?, ?, ?, ?)`,
      )
      .run('quarantine', 'running', 0, JSON.stringify({ test: true }));
    const runId = (
      db.client.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }
    ).id;

    const destAbs = quarantineDestFor(
      root,
      runId,
      new Date().toISOString(),
      'Backup-A',
      'photo.jpg',
    );

    const actionId = insertPlannedAction(db, {
      runId,
      collectionId: a.id,
      srcRelPath: 'photo.jpg',
      destAbsPath: destAbs,
      size: Buffer.from(args.contents).length,
      sha256: expectedHash,
      reason: 'duplicate_within_collection',
    });

    // Place dest per the scenario.
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    if (args.placeDestAs === 'matching' || args.placeDestAs === undefined) {
      fs.writeFileSync(destAbs, args.contents);
    } else if (args.placeDestAs === 'omit') {
      // do nothing
    } else {
      fs.writeFileSync(destAbs, args.placeDestAs);
    }

    const srcAbs = path.join(root, 'Backup-A/photo.jpg');
    if (args.placeSrc === 'missing') {
      try {
        fs.unlinkSync(srcAbs);
      } catch {
        /* may already be gone */
      }
    }

    const action = getAction(db, actionId)!;
    return { db, action, expectedHash, srcAbs, destAbs };
  }

  it('case A: dest present + size+hash match → executed_at set', async () => {
    const { db, action } = await setupInterrupted({
      contents: 'photo-bytes',
      placeDestAs: 'matching',
      placeSrc: 'missing',
    });
    const summary = reconcilePending(db, root);
    expect(summary.crashedRuns).toBe(1);
    expect(summary.pendingActionsResolved).toBe(1);
    expect(summary.pendingActionsErrored).toBe(0);

    const after = getAction(db, action.id)!;
    expect(after.executed_at).toBeTruthy();
    expect(after.error).toBeNull();
    db.client.close();
  });

  it('case B: dest size mismatch → error, executed_at stays null', async () => {
    const { db, action } = await setupInterrupted({
      contents: 'photo-bytes',
      placeDestAs: 'photo', // 5 bytes vs 11 — size differs
      placeSrc: 'missing',
    });
    const summary = reconcilePending(db, root);
    expect(summary.pendingActionsResolved).toBe(0);
    expect(summary.pendingActionsErrored).toBe(1);

    const after = getAction(db, action.id)!;
    expect(after.executed_at).toBeNull();
    expect(after.error).toMatch(/size mismatch/);
    db.client.close();
  });

  it('case C: dest hash mismatch (same size) → error, executed_at stays null', async () => {
    const { db, action } = await setupInterrupted({
      contents: 'photo-bytes',
      placeDestAs: 'photo-bites', // same length, different content
      placeSrc: 'missing',
    });
    const summary = reconcilePending(db, root);
    expect(summary.pendingActionsResolved).toBe(0);
    expect(summary.pendingActionsErrored).toBe(1);

    const after = getAction(db, action.id)!;
    expect(after.executed_at).toBeNull();
    expect(after.error).toMatch(/hash mismatch/);
    db.client.close();
  });

  it('case D: dest missing + src present → error, executed_at stays null', async () => {
    const { db, action, srcAbs } = await setupInterrupted({
      contents: 'photo-bytes',
      placeDestAs: 'omit',
      placeSrc: 'present',
    });
    expect(fs.existsSync(srcAbs)).toBe(true);
    const summary = reconcilePending(db, root);
    expect(summary.pendingActionsResolved).toBe(0);
    expect(summary.pendingActionsErrored).toBe(1);

    const after = getAction(db, action.id)!;
    expect(after.executed_at).toBeNull();
    expect(after.error).toMatch(/src still present/);
    db.client.close();
  });

  it('case E: dest missing + src missing → error, both gone', async () => {
    const { db, action } = await setupInterrupted({
      contents: 'photo-bytes',
      placeDestAs: 'omit',
      placeSrc: 'missing',
    });
    const summary = reconcilePending(db, root);
    expect(summary.pendingActionsResolved).toBe(0);
    expect(summary.pendingActionsErrored).toBe(1);

    const after = getAction(db, action.id)!;
    expect(after.executed_at).toBeNull();
    expect(after.error).toMatch(/both missing/);
    db.client.close();
  });

  it('reconcile is invoked on boot and is idempotent', async () => {
    // Set up an interrupted action, then call boot() again — boot wires
    // reconcilePending in main.ts. After that, a second reconcile should
    // be a no-op.
    const { action } = await setupInterrupted({
      contents: 'x',
      placeDestAs: 'matching',
      placeSrc: 'missing',
    });
    // Re-boot: this should run reconcile.
    await boot({ targetRoot: root, noServe: true });

    const db2 = openDb(root);
    const after = getAction(db2, action.id)!;
    expect(after.executed_at).toBeTruthy();

    // Calling reconcile again should resolve nothing (no pending rows left).
    const second = reconcilePending(db2, root);
    expect(second.pendingActionsResolved).toBe(0);
    expect(second.pendingActionsErrored).toBe(0);
    expect(second.crashedRuns).toBe(0);
    db2.client.close();
  });

  it('end-to-end: a successful quarantine + reconcile is a no-op', async () => {
    buildTree(root, {
      'Backup-A/photo.jpg': 'photo',
      'Backup-B/photo.jpg': 'photo',
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
      scanPrimaryId: scan.scanPrimaryId,
    });

    // Existing actions are already executed; reconcile should not touch them.
    const before = listAllActions(db);
    const summary = reconcilePending(db, root);
    const after = listAllActions(db);

    expect(summary.pendingActionsResolved).toBe(0);
    expect(summary.pendingActionsErrored).toBe(0);
    expect(after).toEqual(before);
    db.client.close();
  });
});

describe('reconcile — running runs', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('reconcile-runs-');
  });
  afterEach(() => rmRf(root));

  it('marks abandoned `running` runs as `crashed`', async () => {
    buildTree(root, { 'Backup-A/x.txt': 'x' });
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    upsertCollection(db, 'Backup-A');

    db.client
      .prepare(`INSERT INTO run (kind, status, dry_run, config_json) VALUES (?, ?, ?, ?)`)
      .run('scan', 'running', 1, '{}');
    db.client
      .prepare(`INSERT INTO run (kind, status, dry_run, config_json) VALUES (?, ?, ?, ?)`)
      .run('quarantine', 'running', 0, '{}');

    const summary = reconcilePending(db, root);
    expect(summary.crashedRuns).toBe(2);

    const rows = db.client.prepare(`SELECT status FROM run`).all() as Array<{ status: string }>;
    for (const r of rows) expect(r.status).toBe('crashed');
    db.client.close();
  });
});

// Suppress unused import warnings — these are used reflectively above.
void listActiveActions;
void listAllLiveFiles;
void setRunStatus;
