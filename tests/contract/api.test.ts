import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb, type Db } from '../../src/db/index.js';
import { buildServer } from '../../src/server/index.js';
import type { FastifyInstance } from 'fastify';

let root: string;
let app: FastifyInstance;
let dbHandle: Db | null = null;

async function setup(files: Record<string, string>) {
  root = makeTmpDir('api-');
  buildTree(root, files);
  await boot({ targetRoot: root, noServe: true });
  const db = openDb(root);
  dbHandle = db;
  app = await buildServer({ db, targetRoot: root, port: 0, dontListen: true });
  return db;
}

afterEach(async () => {
  // Order matters on Windows: stop the Fastify app first (no more requests
  // can land on the DB), then close the DB connection, only then rm the
  // tree. better-sqlite3 holds an open handle on `state.db`; on Windows
  // that handle blocks `unlink` with EBUSY until the connection closes.
  if (app) await app.close();
  if (dbHandle) {
    try {
      // Force-truncate the WAL so the -wal/-shm files are released too.
      dbHandle.client.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* connection may already be closed; ignore */
    }
    try {
      dbHandle.client.close();
    } catch {
      /* ignore double-close */
    }
    dbHandle = null;
  }
  rmRf(root);
});

describe('API — health & config', () => {
  beforeEach(() => {});

  it('GET /health returns ok + uuid', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.uuid).toMatch(/^[0-9a-f]{8}-/);
  });

  it('GET /config returns the loaded config; PUT /config patches it', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r1 = await app.inject({ method: 'GET', url: '/api/config' });
    expect(r1.statusCode).toBe(200);
    const cfg = JSON.parse(r1.body);
    expect(cfg.dry_run).toBe(true);
    expect(cfg.retention_days).toBe(30);

    const r2 = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { retention_days: 7 },
    });
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.body).retention_days).toBe(7);

    // Validation: too small.
    const r3 = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { retention_days: 0 },
    });
    expect(r3.statusCode).toBe(400);
  });

  it('PUT /config refuses to flip gated fields (dry_run, dry_run_disabled_at)', async () => {
    await setup({ 'A/x.txt': 'a' });

    // dry_run
    const r1 = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { dry_run: false },
    });
    expect(r1.statusCode).toBe(400);

    // dry_run_disabled_at
    const r2 = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { dry_run_disabled_at: '2025-01-01T00:00:00Z' },
    });
    expect(r2.statusCode).toBe(400);

    // dry_run is still true after all attempts.
    const cfg = JSON.parse((await app.inject({ method: 'GET', url: '/api/config' })).body);
    expect(cfg.dry_run).toBe(true);

    // A non-gated field still patches normally.
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { retention_days: 14 },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).retention_days).toBe(14);
  });

  it('POST /review/:id/decision rejects quarantined_a/b until the side-quarantine flow is wired', async () => {
    const db = await setup({
      'Backup-A/IMG.jpg': 'verA',
      'Backup-B/IMG.jpg': 'verB',
    });
    const cols = JSON.parse((await app.inject({ method: 'GET', url: '/api/collections' })).body);
    const primary = cols.find((c: { relPath: string }) => c.relPath === 'Backup-B')!;
    await app.inject({
      method: 'POST',
      url: '/api/collections/set-primary',
      payload: { collectionId: primary.id },
    });
    await app.inject({ method: 'POST', url: '/api/scans', payload: {} });
    const items = JSON.parse((await app.inject({ method: 'GET', url: '/api/review' })).body);
    expect(items.length).toBe(1);
    const id = items[0].id;

    // quarantined_a/b would silently set a status without any fs side-effect.
    // Until the chosen-side mover wiring lands, the API must refuse them.
    for (const status of ['quarantined_a', 'quarantined_b']) {
      const r = await app.inject({
        method: 'POST',
        url: `/api/review/${id}/decision`,
        payload: { status },
      });
      expect(r.statusCode).toBe(400);
    }
    db.client.close();
  });

  it('POST /review/:id/decision returns 404 for nonexistent id', async () => {
    const db = await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({
      method: 'POST',
      url: '/api/review/999999/decision',
      payload: { status: 'kept_both' },
    });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error).toBe('review_item_not_found');
    db.client.close();
  });

  it('POST /config/disable-dry-run requires the exact phrase', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({
      method: 'POST',
      url: '/api/config/disable-dry-run',
      payload: { phrase: 'wrong phrase' },
    });
    expect(r.statusCode).toBe(400);

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/config/disable-dry-run',
      payload: { phrase: 'I have reviewed the dry-run report' },
    });
    expect(r2.statusCode).toBe(200);
    const body = JSON.parse(r2.body);
    expect(body.ok).toBe(true);
    expect(body.config.dry_run).toBe(false);
  });
});

describe('API — safety gates around scan/preset overrides', () => {
  it('POST /scans with dryRun:false while config.dry_run=true returns 400 dry_run_gate', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({
      method: 'POST',
      url: '/api/scans',
      payload: { dryRun: false },
    });
    expect(r.statusCode).toBe(400);
    const body = JSON.parse(r.body);
    expect(body.kind).toBe('dry_run_gate');
  });

  it('POST /scans with unknown presetName returns 404 unknown_preset', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({
      method: 'POST',
      url: '/api/scans',
      payload: { presetName: 'definitely-not-a-real-preset' },
    });
    expect(r.statusCode).toBe(404);
    const body = JSON.parse(r.body);
    expect(body.kind).toBe('unknown_preset');
  });

  it('POST /collections/set-primary with unknown id returns 404', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({
      method: 'POST',
      url: '/api/collections/set-primary',
      payload: { collectionId: 999_999 },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('API — collections, presets', () => {
  it('GET /collections lists discovered collections; POST set-primary marks one', async () => {
    await setup({
      'Backup-A/x.txt': 'a',
      'Backup-B/y.txt': 'b',
    });
    const r = await app.inject({ method: 'GET', url: '/api/collections' });
    expect(r.statusCode).toBe(200);
    const cols = JSON.parse(r.body) as Array<{ id: number; relPath: string; isPrimary: boolean }>;
    expect(cols.map((c) => c.relPath).sort()).toEqual(['Backup-A', 'Backup-B']);

    const target = cols.find((c) => c.relPath === 'Backup-B')!;
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/collections/set-primary',
      payload: { collectionId: target.id },
    });
    expect(r2.statusCode).toBe(200);

    const r3 = await app.inject({ method: 'GET', url: '/api/collections' });
    const after = JSON.parse(r3.body) as typeof cols;
    expect(after.find((c) => c.relPath === 'Backup-B')!.isPrimary).toBe(true);
    expect(after.find((c) => c.relPath === 'Backup-A')!.isPrimary).toBe(false);
  });

  it('GET /presets returns built-in presets', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({ method: 'GET', url: '/api/presets' });
    expect(r.statusCode).toBe(200);
    const presets = JSON.parse(r.body);
    const names = presets.map((p: { name: string }) => p.name);
    expect(names).toContain('Samsung Android phone backup');
    expect(names).toContain('None (conservative defaults only)');
  });
});

describe('API — scan + quarantine + restore', () => {
  it('end-to-end via HTTP: scan → disable dry-run → quarantine → restore', async () => {
    const db = await setup({
      'Backup-A/photo.jpg': 'photo',
      'Backup-B/photo.jpg': 'photo',
    });

    // mark primary
    const cols = JSON.parse((await app.inject({ method: 'GET', url: '/api/collections' })).body);
    const primary = cols.find((c: { relPath: string }) => c.relPath === 'Backup-B')!;
    await app.inject({
      method: 'POST',
      url: '/api/collections/set-primary',
      payload: { collectionId: primary.id },
    });

    // start a scan
    const scanResp = await app.inject({ method: 'POST', url: '/api/scans', payload: {} });
    expect(scanResp.statusCode).toBe(200);
    const scan = JSON.parse(scanResp.body);
    expect(scan.report.dryRun).toBe(true);
    expect(scan.report.totalActions).toBe(1);

    // run quarantine while dry-run is still on → 400
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/quarantine/run',
      payload: { scanRunId: scan.runId },
    });
    expect(blocked.statusCode).toBe(400);
    expect(JSON.parse(blocked.body).kind).toBe('dry_run_gate');

    // disable dry-run
    await app.inject({
      method: 'POST',
      url: '/api/config/disable-dry-run',
      payload: { phrase: 'I have reviewed the dry-run report' },
    });

    // run quarantine
    const qResp = await app.inject({
      method: 'POST',
      url: '/api/quarantine/run',
      payload: { scanRunId: scan.runId },
    });
    expect(qResp.statusCode).toBe(200);
    const q = JSON.parse(qResp.body);
    expect(q.summary.executed).toBe(1);

    // /quarantine returns the active row
    const listResp = await app.inject({ method: 'GET', url: '/api/quarantine' });
    const list = JSON.parse(listResp.body);
    expect(list.length).toBe(1);
    const actionId: number = list[0].id;

    // restore it
    const rResp = await app.inject({
      method: 'POST',
      url: '/api/quarantine/restore',
      payload: { actionIds: [actionId] },
    });
    expect(rResp.statusCode).toBe(200);
    const r = JSON.parse(rResp.body);
    expect(r.outcomes[0].outcome.kind).toBe('restored');

    db.client.close();
  });

  it('GET /scans returns the run history; GET /scans/:id returns the run + report', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({ method: 'POST', url: '/api/scans', payload: {} });
    const scan = JSON.parse(r.body);
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/api/scans' })).body);
    expect(list.find((x: { id: number }) => x.id === scan.runId)).toBeDefined();
    const detail = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/scans/${scan.runId}` })).body,
    );
    expect(detail.run.id).toBe(scan.runId);
    expect(detail.report.runId).toBe(scan.runId);
  });

  it('PUT /config rejects unknown fields and out-of-range values', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { sanity_guard_files_pct: 1.5 },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('API — SPA fallback', () => {
  it('non-/api unknown routes return index.html when web/dist is built', async () => {
    await setup({ 'A/x.txt': 'a' });
    // The SPA owns client-side routes like /settings, /quarantine. A hard
    // refresh on those paths lands at Fastify; the not-found handler must
    // return index.html so TanStack Router can take over. If web/dist is
    // not built (CI without `npm run build:web`) this test is skipped.
    const r = await app.inject({ method: 'GET', url: '/settings' });
    if (r.statusCode === 404) {
      // No web/dist present — the embedded fallback only mounts `/`.
      // Skip the assertion in that environment; the contract is enforced
      // when the SPA build is present.
      return;
    }
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toContain('<div id="root">');
  });

  it('unknown /api/* paths return JSON 404, not HTML', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(r.statusCode).toBe(404);
    // Whether the SPA fallback is active or not, /api/* must always be JSON.
    const body = JSON.parse(r.body);
    expect(body.error).toBeDefined();
  });

  it('bare /api (no trailing slash, with or without query) returns JSON 404', async () => {
    // `req.url.startsWith('/api/')` alone would let `/api` and `/api?x=1`
    // fall through to the HTML fallback — wire-shape inconsistency.
    await setup({ 'A/x.txt': 'a' });
    for (const url of ['/api', '/api?probe=1']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, `URL ${url}`).toBe(404);
      // Robust check: the body MUST parse as JSON, regardless of fallback state.
      const body = JSON.parse(r.body);
      expect(body.error, `URL ${url}`).toBeDefined();
    }
  });

  it('SPA fallback emits text/html with charset=utf-8 (when web/dist is built)', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({ method: 'GET', url: '/settings' });
    if (r.statusCode === 404) return; // no web/dist — skip
    expect(r.headers['content-type']).toMatch(/text\/html.*charset=utf-?8/i);
  });
});

describe('API — review queue', () => {
  it('POST /review/:id/decision moves an item out of "open"', async () => {
    const db = await setup({
      'Backup-A/IMG.jpg': 'verA',
      'Backup-B/IMG.jpg': 'verB',
    });
    // Mark a primary so the scan runs.
    const cols = JSON.parse((await app.inject({ method: 'GET', url: '/api/collections' })).body);
    const primary = cols.find((c: { relPath: string }) => c.relPath === 'Backup-B')!;
    await app.inject({
      method: 'POST',
      url: '/api/collections/set-primary',
      payload: { collectionId: primary.id },
    });
    await app.inject({ method: 'POST', url: '/api/scans', payload: {} });
    const items = JSON.parse((await app.inject({ method: 'GET', url: '/api/review' })).body);
    expect(items.length).toBe(1);
    const id = items[0].id;

    const r = await app.inject({
      method: 'POST',
      url: `/api/review/${id}/decision`,
      payload: { status: 'kept_both' },
    });
    expect(r.statusCode).toBe(200);

    const after = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/review?status=open' })).body,
    );
    expect(after.length).toBe(0);
    db.client.close();
  });
});
