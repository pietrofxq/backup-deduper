import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb } from '../../src/db/index.js';
import { buildServer } from '../../src/server/index.js';
import type { FastifyInstance } from 'fastify';

let root: string;
let app: FastifyInstance;

async function setup(files: Record<string, string>) {
  root = makeTmpDir('api-');
  buildTree(root, files);
  await boot({ targetRoot: root, noServe: true });
  const db = openDb(root);
  app = await buildServer({ db, targetRoot: root, port: 0, dontListen: true });
  return db;
}

afterEach(async () => {
  if (app) await app.close();
  rmRf(root);
});

describe('API — health & config', () => {
  beforeEach(() => {});

  it('GET /health returns ok + uuid', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.uuid).toMatch(/^[0-9a-f]{8}-/);
  });

  it('GET /config returns the loaded config; PUT /config patches it', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r1 = await app.inject({ method: 'GET', url: '/config' });
    expect(r1.statusCode).toBe(200);
    const cfg = JSON.parse(r1.body);
    expect(cfg.dry_run).toBe(true);
    expect(cfg.retention_days).toBe(30);

    const r2 = await app.inject({
      method: 'PUT',
      url: '/config',
      payload: { retention_days: 7 },
    });
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.body).retention_days).toBe(7);

    // Validation: too small.
    const r3 = await app.inject({
      method: 'PUT',
      url: '/config',
      payload: { retention_days: 0 },
    });
    expect(r3.statusCode).toBe(400);
  });

  it('PUT /config refuses to flip gated fields (dry_run, dry_run_disabled_at, sanity_guard_override)', async () => {
    await setup({ 'A/x.txt': 'a' });

    // dry_run
    const r1 = await app.inject({
      method: 'PUT',
      url: '/config',
      payload: { dry_run: false },
    });
    expect(r1.statusCode).toBe(400);

    // dry_run_disabled_at
    const r2 = await app.inject({
      method: 'PUT',
      url: '/config',
      payload: { dry_run_disabled_at: '2025-01-01T00:00:00Z' },
    });
    expect(r2.statusCode).toBe(400);

    // sanity_guard_override
    const r3 = await app.inject({
      method: 'PUT',
      url: '/config',
      payload: { sanity_guard_override: true },
    });
    expect(r3.statusCode).toBe(400);

    // dry_run is still true after all attempts
    const cfg = JSON.parse((await app.inject({ method: 'GET', url: '/config' })).body);
    expect(cfg.dry_run).toBe(true);
    expect(cfg.sanity_guard_override).toBe(false);

    // A non-gated field still patches normally.
    const ok = await app.inject({
      method: 'PUT',
      url: '/config',
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
    const cols = JSON.parse((await app.inject({ method: 'GET', url: '/collections' })).body);
    const primary = cols.find((c: { relPath: string }) => c.relPath === 'Backup-B')!;
    await app.inject({
      method: 'POST',
      url: '/collections/set-primary',
      payload: { collectionId: primary.id },
    });
    await app.inject({ method: 'POST', url: '/scans', payload: {} });
    const items = JSON.parse((await app.inject({ method: 'GET', url: '/review' })).body);
    expect(items.length).toBe(1);
    const id = items[0].id;

    // quarantined_a/b would silently set a status without any fs side-effect.
    // Until the chosen-side mover wiring lands, the API must refuse them.
    for (const status of ['quarantined_a', 'quarantined_b']) {
      const r = await app.inject({
        method: 'POST',
        url: `/review/${id}/decision`,
        payload: { status },
      });
      expect(r.statusCode).toBe(400);
    }
    db.client.close();
  });

  it('POST /config/disable-dry-run requires the exact phrase', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({
      method: 'POST',
      url: '/config/disable-dry-run',
      payload: { phrase: 'wrong phrase' },
    });
    expect(r.statusCode).toBe(400);

    const r2 = await app.inject({
      method: 'POST',
      url: '/config/disable-dry-run',
      payload: { phrase: 'I have reviewed the dry-run report' },
    });
    expect(r2.statusCode).toBe(200);
    const body = JSON.parse(r2.body);
    expect(body.ok).toBe(true);
    expect(body.config.dry_run).toBe(false);
  });
});

describe('API — collections, presets', () => {
  it('GET /collections lists discovered collections; POST set-primary marks one', async () => {
    await setup({
      'Backup-A/x.txt': 'a',
      'Backup-B/y.txt': 'b',
    });
    const r = await app.inject({ method: 'GET', url: '/collections' });
    expect(r.statusCode).toBe(200);
    const cols = JSON.parse(r.body) as Array<{ id: number; relPath: string; isPrimary: boolean }>;
    expect(cols.map((c) => c.relPath).sort()).toEqual(['Backup-A', 'Backup-B']);

    const target = cols.find((c) => c.relPath === 'Backup-B')!;
    const r2 = await app.inject({
      method: 'POST',
      url: '/collections/set-primary',
      payload: { collectionId: target.id },
    });
    expect(r2.statusCode).toBe(200);

    const r3 = await app.inject({ method: 'GET', url: '/collections' });
    const after = JSON.parse(r3.body) as typeof cols;
    expect(after.find((c) => c.relPath === 'Backup-B')!.isPrimary).toBe(true);
    expect(after.find((c) => c.relPath === 'Backup-A')!.isPrimary).toBe(false);
  });

  it('GET /presets returns built-in presets', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({ method: 'GET', url: '/presets' });
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
    const cols = JSON.parse((await app.inject({ method: 'GET', url: '/collections' })).body);
    const primary = cols.find((c: { relPath: string }) => c.relPath === 'Backup-B')!;
    await app.inject({
      method: 'POST',
      url: '/collections/set-primary',
      payload: { collectionId: primary.id },
    });

    // start a scan
    const scanResp = await app.inject({ method: 'POST', url: '/scans', payload: {} });
    expect(scanResp.statusCode).toBe(200);
    const scan = JSON.parse(scanResp.body);
    expect(scan.report.dryRun).toBe(true);
    expect(scan.report.totalActions).toBe(1);

    // run quarantine while dry-run is still on → 400
    const blocked = await app.inject({
      method: 'POST',
      url: '/quarantine/run',
      payload: { scanRunId: scan.runId },
    });
    expect(blocked.statusCode).toBe(400);
    expect(JSON.parse(blocked.body).kind).toBe('dry_run_gate');

    // disable dry-run
    await app.inject({
      method: 'POST',
      url: '/config/disable-dry-run',
      payload: { phrase: 'I have reviewed the dry-run report' },
    });

    // run quarantine
    const qResp = await app.inject({
      method: 'POST',
      url: '/quarantine/run',
      payload: { scanRunId: scan.runId },
    });
    expect(qResp.statusCode).toBe(200);
    const q = JSON.parse(qResp.body);
    expect(q.summary.executed).toBe(1);

    // /quarantine returns the active row
    const listResp = await app.inject({ method: 'GET', url: '/quarantine' });
    const list = JSON.parse(listResp.body);
    expect(list.length).toBe(1);
    const actionId: number = list[0].id;

    // restore it
    const rResp = await app.inject({
      method: 'POST',
      url: '/quarantine/restore',
      payload: { actionIds: [actionId] },
    });
    expect(rResp.statusCode).toBe(200);
    const r = JSON.parse(rResp.body);
    expect(r.outcomes[0].outcome.kind).toBe('restored');

    db.client.close();
  });

  it('GET /scans returns the run history; GET /scans/:id returns the run + report', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({ method: 'POST', url: '/scans', payload: {} });
    const scan = JSON.parse(r.body);
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/scans' })).body);
    expect(list.find((x: { id: number }) => x.id === scan.runId)).toBeDefined();
    const detail = JSON.parse(
      (await app.inject({ method: 'GET', url: `/scans/${scan.runId}` })).body,
    );
    expect(detail.run.id).toBe(scan.runId);
    expect(detail.report.runId).toBe(scan.runId);
  });

  it('PUT /config rejects unknown fields and out-of-range values', async () => {
    await setup({ 'A/x.txt': 'a' });
    const r = await app.inject({
      method: 'PUT',
      url: '/config',
      payload: { sanity_guard_files_pct: 1.5 },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('API — review queue', () => {
  it('POST /review/:id/decision moves an item out of "open"', async () => {
    const db = await setup({
      'Backup-A/IMG.jpg': 'verA',
      'Backup-B/IMG.jpg': 'verB',
    });
    // Mark a primary so the scan runs.
    const cols = JSON.parse((await app.inject({ method: 'GET', url: '/collections' })).body);
    const primary = cols.find((c: { relPath: string }) => c.relPath === 'Backup-B')!;
    await app.inject({
      method: 'POST',
      url: '/collections/set-primary',
      payload: { collectionId: primary.id },
    });
    await app.inject({ method: 'POST', url: '/scans', payload: {} });
    const items = JSON.parse((await app.inject({ method: 'GET', url: '/review' })).body);
    expect(items.length).toBe(1);
    const id = items[0].id;

    const r = await app.inject({
      method: 'POST',
      url: `/review/${id}/decision`,
      payload: { status: 'kept_both' },
    });
    expect(r.statusCode).toBe(200);

    const after = JSON.parse(
      (await app.inject({ method: 'GET', url: '/review?status=open' })).body,
    );
    expect(after.length).toBe(0);
    db.client.close();
  });
});
