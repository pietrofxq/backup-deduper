import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ZodApp } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Serve the bundled SPA at `/` if `web/dist/` exists, otherwise fall back
 * to a minimal embedded HTML UI.
 *
 * The SPA uses client-side routing (TanStack Router); a hard refresh on
 * `/settings` arrives at Fastify, not at index.html. We register a
 * NOT_FOUND handler that returns index.html for any non-`/api/*` path so
 * the client router can take over. `/api/*` is unaffected — Fastify only
 * falls through to `setNotFoundHandler` when no route matched, and the
 * API plugin owns every `/api/*` URL.
 */
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
    // Read index.html ONCE at registration. The not-found handler is a hot
    // path — deep links, random probes, or a misconfigured client can land
    // here repeatedly, and a synchronous readFile per request would block
    // the event loop. The bundle's index.html only changes when the user
    // re-runs `npm run build:web` and restarts the server, so caching is
    // safe.
    const indexHtml = fs.readFileSync(path.join(distDir, 'index.html'));
    app.setNotFoundHandler((req, reply) => {
      // Anything under /api/* that 404s is a real 404 — surface as JSON so
      // the SPA's apiClient sees a structured error, not a chunk of HTML.
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.type('text/html').send(indexHtml);
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

// Helpers — every value coming from the API or filesystem (path, basename,
// reason, error message) is set via textContent, never innerHTML. File
// names can contain HTML metacharacters and we run on localhost where the
// user's own files are the only "input" the UI sees.
function el(tag, opts = {}) {
  const e = document.createElement(tag);
  if (opts.text != null) e.textContent = String(opts.text);
  if (opts.cls) e.className = opts.cls;
  return e;
}
function td(text) { return el('td', { text }); }
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

async function refresh() {
  const [health, cfg, cols] = await Promise.all([
    api('GET', '/api/health'),
    api('GET', '/api/config'),
    api('GET', '/api/collections'),
  ]);
  $('targetRoot').textContent = health.json?.targetRoot ?? '';
  const dry = cfg.json?.dry_run;
  const badge = $('dryrunBadge');
  badge.textContent = dry ? 'dry-run' : 'LIVE';
  badge.className = 'badge ' + (dry ? '' : 'ok');

  const tbody = $('collectionsTable').querySelector('tbody');
  clear(tbody);
  for (const c of cols.json ?? []) {
    const tr = el('tr');
    tr.appendChild(td(c.relPath));
    tr.appendChild(td(c.isPrimary ? '✓' : ''));
    const actionTd = el('td');
    const btn = el('button', { text: 'Set primary' });
    btn.onclick = async () => {
      await api('POST', '/api/collections/set-primary', { collectionId: c.id });
      refresh();
    };
    actionTd.appendChild(btn);
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  }
  await refreshQ();
  await refreshReview();
}

async function refreshQ() {
  const tbody = $('quarantineTable').querySelector('tbody');
  clear(tbody);
  const r = await api('GET', '/api/quarantine');
  for (const a of r.json ?? []) {
    const tr = el('tr');
    tr.appendChild(td(a.id));
    tr.appendChild(td(a.collection_id));
    tr.appendChild(td(a.src_rel_path));
    tr.appendChild(td(a.reason));
    tr.appendChild(td(a.size));
    const actionTd = el('td');
    const btn = el('button', { text: 'Restore' });
    btn.onclick = async () => {
      await api('POST', '/api/quarantine/restore', { actionIds: [a.id] });
      refreshQ();
    };
    actionTd.appendChild(btn);
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  }
}

async function refreshReview() {
  const tbody = $('reviewTable').querySelector('tbody');
  clear(tbody);
  const r = await api('GET', '/api/review?status=open');
  for (const item of r.json ?? []) {
    const tr = el('tr');
    tr.appendChild(td(item.basename));
    const aTd = el('td');
    aTd.appendChild(el('span', { text: item.a_rel_path }));
    aTd.appendChild(el('br'));
    aTd.appendChild(el('small', { text: item.a_sha256_hex.slice(0, 8) }));
    tr.appendChild(aTd);
    const bTd = el('td');
    bTd.appendChild(el('span', { text: item.b_rel_path }));
    bTd.appendChild(el('br'));
    bTd.appendChild(el('small', { text: item.b_sha256_hex.slice(0, 8) }));
    tr.appendChild(bTd);
    const actionTd = el('td');
    const btn = el('button', { text: 'keep both' });
    btn.onclick = async () => {
      await api('POST', '/api/review/' + item.id + '/decision', { status: 'kept_both' });
      refreshReview();
    };
    actionTd.appendChild(btn);
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  }
}

function setReportBox(rep) {
  const box = $('reportBox');
  clear(box);
  const h = el('h3', { text: 'Run ' + rep.runId });
  box.appendChild(h);
  const total = el('div');
  total.appendChild(document.createTextNode('Total actions: '));
  const b = el('b', { text: String(rep.totalActions) });
  total.appendChild(b);
  total.appendChild(document.createTextNode(' (' + rep.totalBytes + ' bytes)'));
  box.appendChild(total);
  box.appendChild(el('div', { text: 'Review pairs: ' + rep.reviewPairs + ', empty dirs: ' + rep.emptyDirActions }));
  box.appendChild(
    el('div', {
      text:
        'Sanity guard: ' +
        (rep.sanityGuard.passed
          ? '✓ passed'
          : '✗ TRIPPED — ' + (rep.sanityGuard.reason ?? '')),
    }),
  );
  box.appendChild(el('pre', { text: JSON.stringify(rep.countsByReason, null, 2) }));
}

$('scanBtn').onclick = async () => {
  $('lastRunStatus').textContent = 'Scanning…';
  const r = await api('POST', '/api/scans', {});
  if (!r.ok) {
    const box = $('reportBox');
    clear(box);
    box.appendChild(el('div', { text: 'scan failed', cls: 'danger' }));
    box.appendChild(el('pre', { text: r.text }));
    return;
  }
  lastScanRunId = r.json.runId;
  $('quarantineBtn').disabled = false;
  setReportBox(r.json.report);
  $('lastRunStatus').textContent = 'last scan: run ' + r.json.report.runId;
  refresh();
};

$('quarantineBtn').onclick = async () => {
  if (!lastScanRunId) return;
  if (!confirm('Run quarantine for scan ' + lastScanRunId + '?')) return;
  const r = await api('POST', '/api/quarantine/run', { scanRunId: lastScanRunId });
  $('reportBox').appendChild(el('pre', { text: JSON.stringify(r.json, null, 2) }));
  refresh();
};

$('disableBtn').onclick = async () => {
  const phrase = $('phrase').value;
  const r = await api('POST', '/api/config/disable-dry-run', { phrase });
  const msg = $('disableMsg');
  clear(msg);
  if (r.ok) {
    msg.appendChild(el('div', { text: 'dry-run disabled', cls: 'badge ok' }));
  } else {
    msg.appendChild(el('div', { text: r.json?.error ?? 'failed', cls: 'danger' }));
  }
  refresh();
};

$('refreshQ').onclick = refresh;

refresh();
</script>
</body>
</html>`;
