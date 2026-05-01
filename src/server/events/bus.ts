/**
 * In-process event bus for streaming scan progress to SSE clients.
 *
 * Why in-process and not a queue: this server is a single-process desktop
 * tool. There is exactly one orchestrator publishing and at most a handful
 * of browser tabs subscribing. A queue/bus library would be more moving
 * parts than warranted.
 *
 * Replay semantics: every event is assigned a monotonic id. The bus keeps
 * the last `BUFFER_SIZE` events, so a client that reconnects with a
 * `Last-Event-ID` header receives whatever it missed (within the window).
 * Clients that fall further behind get a `replay_lost` synthetic event so
 * they know to refetch state instead of trusting partial progress.
 *
 * Cancellation lives next to the bus rather than in its own module so the
 * route layer has one thing to import. Each in-flight scan registers an
 * AbortController under its runId; the cancel route flips it; the
 * orchestrator polls `signal.aborted` between hashed files.
 */

export type ScanEventType =
  | 'phase'
  | 'discovered'
  | 'hashed'
  | 'collection_done'
  | 'classified'
  | 'done'
  | 'aborted'
  | 'failed'
  | 'replay_lost';

export interface ScanEvent {
  /** Monotonic across the bus. Sent as the SSE `id:` line. */
  id: number;
  type: ScanEventType;
  runId: number | null;
  data: unknown;
  /** epoch ms — purely for debugging and log replay. */
  ts: number;
}

const BUFFER_SIZE = 200;

export type Subscriber = (event: ScanEvent) => void;

export class EventBus {
  private nextId = 1;
  private buffer: ScanEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private controllers = new Map<number, AbortController>();

  publish(type: ScanEventType, runId: number | null, data: unknown): ScanEvent {
    const event: ScanEvent = {
      id: this.nextId++,
      type,
      runId,
      data,
      ts: Date.now(),
    };
    this.buffer.push(event);
    while (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        /* a misbehaving subscriber must not poison the publisher */
      }
    }
    return event;
  }

  /**
   * Subscribe to live events. If `lastEventId` is provided, the bus first
   * replays buffered events with `id > lastEventId`. If those events are no
   * longer in the buffer (client fell too far behind), a synthetic
   * `replay_lost` event is sent and the client should refetch state.
   */
  subscribe(handler: Subscriber, lastEventId?: number): () => void {
    if (lastEventId !== undefined) {
      const oldest = this.buffer[0]?.id ?? this.nextId;
      if (lastEventId < oldest - 1) {
        handler({
          id: this.nextId++,
          type: 'replay_lost',
          runId: null,
          data: { since: lastEventId, oldestAvailable: oldest },
          ts: Date.now(),
        });
      } else {
        for (const e of this.buffer) {
          if (e.id > lastEventId) handler(e);
        }
      }
    }
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  /** Test/inspection helper. */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Register an AbortController for a scan run so the cancel route can
   * flip it without touching the orchestrator.
   */
  registerCancellable(runId: number, controller: AbortController): void {
    this.controllers.set(runId, controller);
  }

  unregisterCancellable(runId: number): void {
    this.controllers.delete(runId);
  }

  /** Returns true if a controller was found and aborted. */
  cancel(runId: number, reason = 'cancelled by user'): boolean {
    const c = this.controllers.get(runId);
    if (!c) return false;
    if (!c.signal.aborted) c.abort(reason);
    return true;
  }

  /** Test-only: drop everything. */
  reset(): void {
    this.subscribers.clear();
    this.controllers.clear();
    this.buffer = [];
    this.nextId = 1;
  }
}

/**
 * Singleton bus. The server registers exactly one bus per process; routes
 * and orchestrator callers reach it through the `events` field on
 * `ServerDeps` rather than this global, so tests can swap a fresh bus per
 * scenario without leaking subscribers between cases.
 */
export const globalEventBus = new EventBus();
