import type { ScanEvent } from './bus.js';

/**
 * Backpressure-aware writer for the SSE route.
 *
 * Why this exists as a separate module: the coalescing + queuing rules
 * are subtle (terminal events must never be dropped, high-frequency
 * "hashed" events should collapse to the latest while paused, the queue
 * must drain in arrival order on `drain`) and worth a focused unit test.
 * Wrapping the logic against an injected `WritableLike` lets us exercise
 * every branch without spinning up a real Fastify server and TCP socket.
 *
 * The contract:
 *   - send(event): if not paused, write immediately and update `paused`
 *     based on the writer's return value. If paused, route the event:
 *       * `coalescingTypes` set → keep only the latest (`pendingCoalesced`).
 *       * everything else → push onto the FIFO queue.
 *   - onDrain(): flush queue (FIFO), then the coalesced pending event if
 *     any. Re-pause if the writer returns false again.
 *   - dispose(): drop pending state. Used by route cleanup so a torn-down
 *     stream doesn't leak references.
 */
export interface WritableLike {
  write(text: string): boolean;
}

export interface BackpressuredWriterOptions {
  writable: WritableLike;
  /**
   * Event type names that should COLLAPSE to the latest while paused.
   * Defaults to {hashed}. Anything outside this set is queued in arrival
   * order and replayed in full on drain.
   */
  coalescingTypes?: ReadonlySet<string>;
  serialize: (event: ScanEvent) => string;
}

export interface BackpressuredWriter {
  send(event: ScanEvent): void;
  onDrain(): void;
  /** True when the writer is waiting for a drain. */
  isPaused(): boolean;
  /** Test/inspection — returns the current backlog depth. */
  pendingDepth(): { queued: number; coalesced: boolean };
  dispose(): void;
}

const DEFAULT_COALESCING = new Set(['hashed']);

export function createBackpressuredWriter(
  opts: BackpressuredWriterOptions,
): BackpressuredWriter {
  const { writable, serialize } = opts;
  const coalescingTypes = opts.coalescingTypes ?? DEFAULT_COALESCING;

  let paused = false;
  let pendingCoalesced: ScanEvent | null = null;
  const queue: ScanEvent[] = [];

  function writeRaw(text: string): boolean {
    let ok = false;
    try {
      ok = writable.write(text);
    } catch {
      // Socket torn down — caller will dispose us via cleanup.
      return false;
    }
    if (!ok) paused = true;
    return ok;
  }

  return {
    send(event: ScanEvent): void {
      if (paused) {
        if (coalescingTypes.has(event.type)) {
          pendingCoalesced = event;
        } else {
          queue.push(event);
        }
        return;
      }
      writeRaw(serialize(event));
    },
    onDrain(): void {
      paused = false;
      while (!paused && queue.length > 0) {
        const next = queue.shift();
        if (next) writeRaw(serialize(next));
      }
      if (!paused && pendingCoalesced) {
        const last = pendingCoalesced;
        pendingCoalesced = null;
        writeRaw(serialize(last));
      }
    },
    isPaused: () => paused,
    pendingDepth: () => ({
      queued: queue.length,
      coalesced: pendingCoalesced !== null,
    }),
    dispose(): void {
      queue.length = 0;
      pendingCoalesced = null;
    },
  };
}
