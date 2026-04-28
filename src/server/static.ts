import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ZodApp } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Locate the bundled web/dist folder if it exists; otherwise fall back to a minimal embedded UI. */
export async function registerStaticUi(app: ZodApp): Promise<void> {
  const distCandidates = [
    path.resolve(HERE, '../../web/dist'),
    path.resolve(HERE, '../../../web/dist'),
  ];
  const distDir = distCandidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
  if (distDir) {
    const fastifyStatic = await import('@fastify/static');
    await app.register(fastifyStatic.default, {
      root: distDir,
      prefix: '/',
    });
    return;
  }
  // Fallback: serve the embedded single-file UI on `/`.
  app.get('/', async (_req, reply) => {
    reply.type('text/html').send(EMBEDDED_HTML);
  });
}

const EMBEDDED_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>safe-dedupe</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 2rem; max-width: 1100px; }
  header { display: flex; align-items: baseline; gap: 1rem; }
  h1 { margin: 0; font-size: 1.4rem; }
  .badge { background:#fff3cd; padding:.2rem .5rem; border-radius:4px; font-size:.85rem; }
  .ok { background:#d4edda; }
  section { margin-top: 2rem; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { padding: .35rem .5rem; border-bottom: 1px solid #ddd; text-align: left; }
  button { padding: .4rem .8rem; cursor: pointer; }
  .danger { background:#f8d7da; padding:.5rem 1rem; border-radius:6px; margin-top:.5rem; }
  pre { background:#f6f6f6; padding: .8rem; overflow-x:auto; }
  input[type=text] { padding: .3rem .5rem; width: 22rem; }
</style>
</head>
<body>
<header>
  <h1>safe-dedupe</h1>
  <span id="dryrunBadge" class="badge">dry-run</span>
  <span id="targetRoot" style="color:#666"></span>
</header>

<section>
  <h2>Collections</h2>
  <table id="collectionsTable">
    <thead><tr><th>Path</th><th>Primary?</th><th></th></tr></thead>
    <tbody></tbody>
  </table>
</section>

<section>
  <h2>Run</h2>
  <button id="scanBtn">Scan now</button>
  <button id="quarantineBtn" disabled>Run quarantine</button>
  <span id="lastRunStatus" style="margin-left:1rem; color:#666"></span>
  <div id="reportBox"></div>
</section>

<section>
  <h2>Disable dry-run</h2>
  <p>Type the exact phrase: <code>I have reviewed the dry-run report</code></p>
  <input type="text" id="phrase" />
  <button id="disableBtn">Disable dry-run</button>
  <div id="disableMsg"></div>
</section>

<section>
  <h2>Quarantine</h2>
  <button id="refreshQ">Refresh</button>
  <table id="quarantineTable">
    <thead><tr><th>id</th><th>collection</th><th>rel-path</th><th>reason</th><th>size</th><th></th></tr></thead>
    <tbody></tbody>
  </table>
</section>

<section>
  <h2>Review queue (name collisions)</h2>
  <table id="reviewTable">
    <thead><tr><th>basename</th><th>A</th><th>B</th><th></th></tr></thead>
    <tbody></tbody>
  </table>
</section>

<script>
const $ = (id) => document.getElementById(id);
let lastScanRunId = null;

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, json, text };
}

async function refresh() {
  const [health, cfg, cols] = await Promise.all([
    api('GET', '/health'),
    api('GET', '/config'),
    api('GET', '/collections'),
  ]);
  $('targetRoot').textContent = health.json?.targetRoot ?? '';
  const dry = cfg.json?.dry_run;
  const badge = $('dryrunBadge');
  badge.textContent = dry ? 'dry-run' : 'LIVE';
  badge.className = 'badge ' + (dry ? '' : 'ok');

  const tbody = $('collectionsTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const c of cols.json ?? []) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + c.relPath + '</td><td>' + (c.isPrimary ? '✓' : '') + '</td><td><button data-id="' + c.id + '">Set primary</button></td>';
    tr.querySelector('button').onclick = async () => {
      await api('POST', '/collections/set-primary', { collectionId: c.id });
      refresh();
    };
    tbody.appendChild(tr);
  }
  await refreshQ();
  await refreshReview();
}

async function refreshQ() {
  const tbody = $('quarantineTable').querySelector('tbody');
  tbody.innerHTML = '';
  const r = await api('GET', '/quarantine');
  for (const a of r.json ?? []) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + a.id + '</td><td>' + a.collection_id + '</td><td>' + a.src_rel_path + '</td><td>' + a.reason + '</td><td>' + a.size + '</td><td><button data-id="' + a.id + '">Restore</button></td>';
    tr.querySelector('button').onclick = async () => {
      await api('POST', '/quarantine/restore', { actionIds: [a.id] });
      refreshQ();
    };
    tbody.appendChild(tr);
  }
}

async function refreshReview() {
  const tbody = $('reviewTable').querySelector('tbody');
  tbody.innerHTML = '';
  const r = await api('GET', '/review?status=open');
  for (const item of r.json ?? []) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + item.basename + '</td><td>' + item.a_rel_path + '<br><small>' + item.a_sha256_hex.slice(0,8) + '</small></td><td>' + item.b_rel_path + '<br><small>' + item.b_sha256_hex.slice(0,8) + '</small></td><td><button data-act="kept_both">keep both</button></td>';
    tr.querySelector('button').onclick = async () => {
      await api('POST', '/review/' + item.id + '/decision', { status: 'kept_both' });
      refreshReview();
    };
    tbody.appendChild(tr);
  }
}

$('scanBtn').onclick = async () => {
  $('lastRunStatus').textContent = 'Scanning…';
  const r = await api('POST', '/scans', {});
  if (!r.ok) { $('reportBox').innerHTML = '<div class="danger">scan failed</div><pre>' + r.text + '</pre>'; return; }
  lastScanRunId = r.json.runId;
  $('quarantineBtn').disabled = false;
  const rep = r.json.report;
  $('reportBox').innerHTML =
    '<h3>Run ' + rep.runId + '</h3>' +
    '<div>Total actions: <b>' + rep.totalActions + '</b> (' + rep.totalBytes + ' bytes)</div>' +
    '<div>Review pairs: ' + rep.reviewPairs + ', empty dirs: ' + rep.emptyDirActions + '</div>' +
    '<div>Sanity guard: ' + (rep.sanityGuard.passed ? '✓ passed' : '✗ TRIPPED — ' + rep.sanityGuard.reason) + '</div>' +
    '<pre>' + JSON.stringify(rep.countsByReason, null, 2) + '</pre>';
  $('lastRunStatus').textContent = 'last scan: run ' + rep.runId;
  refresh();
};

$('quarantineBtn').onclick = async () => {
  if (!lastScanRunId) return;
  if (!confirm('Run quarantine for scan ' + lastScanRunId + '?')) return;
  const r = await api('POST', '/quarantine/run', { scanRunId: lastScanRunId });
  $('reportBox').innerHTML += '<pre>' + JSON.stringify(r.json, null, 2) + '</pre>';
  refresh();
};

$('disableBtn').onclick = async () => {
  const phrase = $('phrase').value;
  const r = await api('POST', '/config/disable-dry-run', { phrase });
  $('disableMsg').innerHTML = r.ok
    ? '<div class="badge ok">dry-run disabled</div>'
    : '<div class="danger">' + (r.json?.error ?? 'failed') + '</div>';
  refresh();
};

$('refreshQ').onclick = refresh;

refresh();
</script>
</body>
</html>`;
