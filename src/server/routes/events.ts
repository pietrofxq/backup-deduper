import type { ServerDeps } from '../index.js';
import type { ZodApp } from '../types.js';
import type { EventBus, ScanEvent } from '../events/bus.js';
import { createBackpressuredWriter } from '../events/backpressure.js';

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Server-Sent Events stream. The browser opens a long-lived connection;
 * progress callbacks from the orchestrator land here as `event: <type>`
 * frames. Reconnection is handled by EventSource via the `Last-Event-ID`
 * header — the bus replays anything still in its ring buffer.
 *
 * Heartbeat: every 15s we emit a `: ping` comment line. SSE comments are
 * silently dropped by EventSource clients but keep intermediate proxies
 * (and the browser's network tab) from idling out the connection.
 */
export async function registerEventRoutes(app: ZodApp, deps: ServerDeps): Promise<void> {
  app.get('/events', async (req, reply) => {
    const bus = deps.events;
    if (!bus) {
      return reply.code(503).send({ error: 'event bus not configured' });
    }

    // Long-lived response — disable Fastify's serializer / response timeout.
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache, no-transform');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.setHeader('x-accel-buffering', 'no'); // disable nginx buffering when proxied
    reply.raw.flushHeaders?.();

    // Initial frame: tell the client the connection is live so the UI can
    // flip out of "connecting…" before the first real event lands.
    reply.raw.write(`: connected\n\n`);

    const lastEventIdHeader = req.headers['last-event-id'];
    const lastEventId = parseLastEventId(lastEventIdHeader);

    /**
     * Backpressure / coalescing strategy.
     *
     * `reply.raw.write()` returns false when the kernel send buffer is
     * full. Without paying attention to that signal, Node buffers writes
     * in memory unboundedly — a slow client during a long scan emitting
     * tens of thousands of `hashed` events could swell process RSS into
     * the GBs.
     *
     * Logic lives in `backpressure.ts` so it can be unit-tested without a
     * real socket. Defaults: `hashed` events coalesce (only the latest
     * survives the pause); everything else queues in arrival order so
     * state-changing frames (phase / done / aborted / failed) are never
     * dropped.
     */
    const writer = createBackpressuredWriter({
      writable: reply.raw,
      serialize: frame,
    });

    function frame(event: ScanEvent): string {
      // Each frame: id, event, data — separated by \n, terminated by \n\n.
      // JSON is single-line so newlines in payload would break the wire format;
      // JSON.stringify guarantees no raw newlines in the output.
      //
      // `event.data` is typed `unknown` on the bus, so we can't assume an
      // object — a publisher passing a primitive or null would throw on
      // spread. Guard explicitly: object payloads merge into the envelope,
      // anything else gets nested under `value` so the client still sees it.
      const envelope: Record<string, unknown> = {
        runId: event.runId,
        ts: event.ts,
      };
      if (event.data !== null && typeof event.data === 'object') {
        Object.assign(envelope, event.data);
      } else if (event.data !== undefined) {
        envelope.value = event.data;
      }
      return (
        `id: ${event.id}\n` +
        `event: ${event.type}\n` +
        `data: ${JSON.stringify(envelope)}\n\n`
      );
    }

    const flushOnDrain = () => writer.onDrain();
    reply.raw.on('drain', flushOnDrain);

    const unsubscribe = bus.subscribe((event) => writer.send(event), lastEventId);

    const heartbeat = setInterval(() => {
      // Comment frames are valid SSE and do not invoke the client's onmessage.
      // Skip when paused — the heartbeat is a liveness ping, not load-bearing
      // data, and adding to the buffer while we're already backed up just
      // makes the situation worse.
      if (writer.isPaused()) return;
      try {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        // Socket may be torn down between checks — cleanup handles it.
      }
    }, HEARTBEAT_INTERVAL_MS);
    // Don't keep the Node process alive for the heartbeat alone; the request
    // owner already keeps it alive.
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      reply.raw.removeListener('drain', flushOnDrain);
      unsubscribe();
      writer.dispose();
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    // Returning a never-resolving promise keeps Fastify from auto-ending the
    // response. Cleanup runs on the underlying socket close event.
    return new Promise<void>(() => {
      /* never resolves */
    });
  });
}

function parseLastEventId(header: string | string[] | undefined): number | undefined {
  if (header === undefined) return undefined;
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export type { EventBus };
