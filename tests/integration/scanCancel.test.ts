import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb } from '../../src/db/index.js';
import { getRun, listCollections, setPrimary } from '../../src/db/queries.js';
import {
  runScanJob,
  ScanAbortedError,
} from '../../src/orchestrator/scanJob.js';
import { syncCollectionsTable } from '../../src/scanner/index.js';

/**
 * Cooperative cancellation must reach every phase boundary, not just the
 * pre-scan check. Earlier the orchestrator only sampled `signal.aborted`
 * before/after `scanAll()`; an abort that landed during classify, review-
 * pair persistence, or report-write would still flip the run row to
 * `completed`. These tests exercise each post-scan boundary by aborting
 * after the work that should NOT have run.
 */
describe('scanJob — cooperative cancellation at every phase', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('cancel-');
  });
  afterEach(() => rmRf(root));

  async function setupTree() {
    buildTree(root, {
      'Backup-A/DCIM/Camera/IMG_1.jpg': 'photo1',
      'Backup-A/DCIM/Camera/COLLISION.jpg': 'verA',
      'Backup-B/DCIM/Camera/IMG_1.jpg': 'photo1',
      'Backup-B/DCIM/Camera/COLLISION.jpg': 'verB',
      'Backup-B/notes.txt': 'unique',
    });
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    syncCollectionsTable(db, root);
    const primary = listCollections(db).find((c) => c.rel_path === 'Backup-B')!;
    setPrimary(db, primary.id);
    return db;
  }

  it('aborts mid-scan when signal flips before scanAll returns', async () => {
    const db = await setupTree();
    try {
      const ac = new AbortController();
      // Abort once we know the run row exists — *before* scan returns.
      let runId = -1;
      const promise = runScanJob(db, root, {
        dryRun: true,
        signal: ac.signal,
        onRunCreated: (id) => {
          runId = id;
          ac.abort();
        },
      });
      await expect(promise).rejects.toBeInstanceOf(ScanAbortedError);
      const row = getRun(db, runId);
      expect(row?.status).toBe('aborted');
    } finally {
      db.client.close();
    }
  });

  it('aborts at the post-classify checkpoint', async () => {
    const db = await setupTree();
    try {
      const ac = new AbortController();
      let runId = -1;
      // Flip the signal *after* the classify-phase event lands — this
      // is between scanAll's return and the review-pair insert loop.
      const promise = runScanJob(db, root, {
        dryRun: true,
        signal: ac.signal,
        onRunCreated: (id) => {
          runId = id;
        },
        onProgress: (e) => {
          if (e.type === 'classified') ac.abort();
        },
      });
      await expect(promise).rejects.toBeInstanceOf(ScanAbortedError);
      const row = getRun(db, runId);
      expect(row?.status).toBe('aborted');
    } finally {
      db.client.close();
    }
  });

  it('aborts at the report-phase checkpoint', async () => {
    const db = await setupTree();
    try {
      const ac = new AbortController();
      let runId = -1;
      const promise = runScanJob(db, root, {
        dryRun: true,
        signal: ac.signal,
        onRunCreated: (id) => {
          runId = id;
        },
        onProgress: (e) => {
          if (e.type === 'phase' && e.phase === 'report') ac.abort();
        },
      });
      await expect(promise).rejects.toBeInstanceOf(ScanAbortedError);
      const row = getRun(db, runId);
      expect(row?.status).toBe('aborted');
    } finally {
      db.client.close();
    }
  });

  it('completes normally when no abort fires', async () => {
    const db = await setupTree();
    try {
      const ac = new AbortController();
      const result = await runScanJob(db, root, {
        dryRun: true,
        signal: ac.signal,
      });
      const row = getRun(db, result.runId);
      expect(row?.status).toBe('completed');
    } finally {
      db.client.close();
    }
  });
});
