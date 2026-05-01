import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/server/events/bus.js';

describe('EventBus', () => {
  it('publishes events with monotonically increasing ids', () => {
    const bus = new EventBus();
    const a = bus.publish('phase', 1, { phase: 'scan' });
    const b = bus.publish('phase', 1, { phase: 'classify' });
    expect(b.id).toBe(a.id + 1);
  });

  it('delivers live events to subscribers', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.subscribe((e) => seen.push(e.id));
    bus.publish('phase', 1, { phase: 'scan' });
    bus.publish('phase', 1, { phase: 'classify' });
    expect(seen).toEqual([1, 2]);
  });

  it('replays buffered events to a late subscriber when given lastEventId', () => {
    const bus = new EventBus();
    bus.publish('phase', 1, { phase: 'scan' });
    bus.publish('phase', 1, { phase: 'classify' });
    bus.publish('phase', 1, { phase: 'done' });
    const received: number[] = [];
    bus.subscribe((e) => received.push(e.id), 1);
    expect(received).toEqual([2, 3]);
  });

  it('emits replay_lost when the requested lastEventId is older than the buffer window', () => {
    const bus = new EventBus();
    // Push 250 events; buffer holds ~200 so the first 50 fall off.
    for (let i = 0; i < 250; i++) bus.publish('hashed', 1, { i });
    const seen: { id: number; type: string }[] = [];
    bus.subscribe((e) => seen.push({ id: e.id, type: e.type }), 5);
    expect(seen[0]?.type).toBe('replay_lost');
  });

  it('unsubscribe stops further deliveries', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const stop = bus.subscribe((e) => seen.push(e.id));
    bus.publish('phase', 1, { phase: 'scan' });
    stop();
    bus.publish('phase', 1, { phase: 'classify' });
    expect(seen).toEqual([1]);
  });

  it('cancel triggers the registered AbortController and returns true', () => {
    const bus = new EventBus();
    const ctrl = new AbortController();
    bus.registerCancellable(42, ctrl);
    expect(bus.cancel(42)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('cancel returns false when no controller is registered', () => {
    const bus = new EventBus();
    expect(bus.cancel(99)).toBe(false);
  });

  it('a misbehaving subscriber does not stop other subscribers from receiving events', () => {
    const bus = new EventBus();
    const good: number[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => good.push(e.id));
    bus.publish('phase', 1, { phase: 'scan' });
    expect(good).toEqual([1]);
  });
});
