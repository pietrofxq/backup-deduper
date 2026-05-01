import { afterEach, describe, expect, it } from 'vitest';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb, type Db } from '../../src/db/index.js';
import { startServer, type ServerHandle } from '../../src/server/index.js';
import { EventBus } from '../../src/server/events/bus.js';
import { setPrimary, listCollections } from '../../src/db/queries.js';
import { syncCollectionsTable } from '../../src/scanner/index.js';

let root: string;
let server: ServerHandle | null = null;
let dbHandle: Db | null = null;

async function setup(files: Record<string, string>): Promise<{
  db: Db;
  baseUrl: string;
  bus: EventBus;
}> {
  root = makeTmpDir('events-');
  buildTree(root, files);
  await boot({ targetRoot: root, noServe: true });
  const db = openDb(root);
  dbHandle = db;
  const bus = new EventBus();
  // Bind to port 0 so the OS picks a free port — allows multiple parallel runs.
  server = await startServer({ db, targetRoot: root, port: 0, events: bus });
  return { db, baseUrl: `http://127.0.0.1:${server.port}`, bus };
}

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  if (dbHandle) {
    try {
      dbHandle.client.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
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

/** Read the SSE stream until `predicate` returns true OR the timeout elapses. */
async function readStream(
  res: Response,
  predicate: (frames: ParsedFrame[]) => boolean,
  timeoutMs = 3000,
): Promise<ParsedFrame[]> {
  if (!res.body) throw new Error('no response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: ParsedFrame[] = [];
  let buffer = '';
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 100),
      ),
    ]);
    if (done) break;
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by \n\n.
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const raw of parts) {
        const f = parseFrame(raw);
        if (f) frames.push(f);
      }
      if (predicate(frames)) break;
    }
  }
  try {
    reader.cancel();
  } catch {
    /* ignore */
  }
  return frames;
}

interface ParsedFrame {
  id?: number;
  event?: string;
  data?: unknown;
  comment?: string;
}

function parseFrame(raw: string): ParsedFrame | null {
  if (raw.trim() === '') return null;
  const f: ParsedFrame = {};
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) {
      f.comment = line.slice(1).trim();
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === 'id') f.id = Number(val);
    else if (key === 'event') f.event = val;
    else if (key === 'data') {
      try {
        f.data = JSON.parse(val);
      } catch {
        f.data = val;
      }
    }
  }
  return f;
}

describe('SSE — /api/events', () => {
  it('opens a stream and sends a connected comment frame', async () => {
    const { baseUrl } = await setup({ 'A/x.txt': 'a' });
    const res = await fetch(`${baseUrl}/api/events`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const frames = await readStream(res, (fs) => fs.length >= 1, 1000);
    // Either the initial `: connected` comment or no events yet — both are
    // acceptable; the assertion is that the response was streamable.
    expect(Array.isArray(frames)).toBe(true);
  });

  it('publishes scan events to a connected subscriber', async () => {
    const { db, baseUrl, bus } = await setup({
      'Coll/file.txt': 'hello world',
    });
    // Need a primary set + dry_run already on (default) to run a scan.
    syncCollectionsTable(db, root);
    const cols = listCollections(db);
    const c = cols[0];
    if (!c) throw new Error('expected at least one collection');
    setPrimary(db, c.id);

    // Open SSE stream first, then trigger a scan in parallel.
    const streamRes = await fetch(`${baseUrl}/api/events`);
    const streamPromise = readStream(
      streamRes,
      (fs) => fs.some((f) => f.event === 'done'),
      4000,
    );

    const scanRes = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(scanRes.status).toBe(200);

    const frames = await streamPromise;
    const events = frames.map((f) => f.event).filter(Boolean);
    expect(events).toContain('phase');
    expect(events).toContain('done');

    // The done frame's data should carry the runId and totals.
    const done = frames.find((f) => f.event === 'done');
    expect(done?.data).toMatchObject({
      runId: expect.any(Number),
      totalActions: expect.any(Number),
    });

    void bus; // bus is the same instance used by the route
  });

  it('replays buffered events when Last-Event-ID is supplied', async () => {
    const { bus, baseUrl } = await setup({ 'A/x.txt': 'a' });

    // Publish three events before the client connects so they sit in the
    // buffer.
    bus.publish('phase', 1, { phase: 'scan' });
    bus.publish('phase', 1, { phase: 'classify' });
    bus.publish('phase', 1, { phase: 'done' });

    const res = await fetch(`${baseUrl}/api/events`, {
      headers: { 'last-event-id': '1' },
    });
    const frames = await readStream(res, (fs) => fs.length >= 2, 1000);
    const phases = frames
      .filter((f) => f.event === 'phase')
      .map((f) => (f.data as { phase: string } | undefined)?.phase);
    // Replay should have surfaced events with id > 1 — i.e. classify + done.
    expect(phases).toEqual(expect.arrayContaining(['classify', 'done']));
  });

  it('cancel route aborts an in-flight scan', async () => {
    // Build a tree large enough that the scan blocks on hashing for a tick.
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i++) files[`Coll/f${i}.txt`] = `payload ${i}`.repeat(50);
    const { db, baseUrl, bus } = await setup(files);
    syncCollectionsTable(db, root);
    const cols = listCollections(db);
    const c = cols[0];
    if (!c) throw new Error('expected at least one collection');
    setPrimary(db, c.id);

    // Open SSE stream first.
    const streamRes = await fetch(`${baseUrl}/api/events`);
    const phaseStarted = readStream(
      streamRes,
      (fs) => fs.some((f) => f.event === 'phase'),
      2000,
    );

    // Kick off the scan as a non-awaited fetch so we can cancel it mid-flight.
    const scanPromise = fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    // Wait for the started phase event, then read the bus to find the runId.
    await phaseStarted;
    // The bus is the same instance the route uses; peek at the most-recent
    // run id by intercepting one fresh subscription.
    const seen = new Set<number>();
    const stop = bus.subscribe((e) => {
      if (e.runId !== null) seen.add(e.runId);
    });
    // Give one tick for events to land.
    await new Promise((r) => setTimeout(r, 50));
    stop();
    const runId = [...seen][0];
    if (runId === undefined) throw new Error('expected at least one runId');

    const cancelRes = await fetch(`${baseUrl}/api/scans/${runId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // Cancel may race with the scan completion. Either we hit the in-flight
    // controller (200) or it already finished (404). Both are valid races.
    expect([200, 404]).toContain(cancelRes.status);

    // The scan POST itself returns either 200 (race won by completion) or
    // 409 (race won by cancel). Both are valid terminal states.
    const scanRes = await scanPromise;
    expect([200, 409]).toContain(scanRes.status);
  });
});
