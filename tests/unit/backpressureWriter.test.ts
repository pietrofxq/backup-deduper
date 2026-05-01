import { describe, expect, it } from 'vitest';
import { createBackpressuredWriter } from '../../src/server/events/backpressure.js';
import type { ScanEvent } from '../../src/server/events/bus.js';

/**
 * The route uses this writer to mediate between the EventBus and the
 * underlying TCP socket. Coverage targets the rules that matter when a
 * slow client triggers backpressure mid-scan:
 *
 *   - terminal / state-changing events must NEVER be dropped
 *   - high-frequency events (`hashed`) collapse to only the latest
 *   - drain replays the queue in arrival order, then the coalesced one
 *   - re-pause during drain leaves remaining items queued
 */

interface FakeWritable {
  write(text: string): boolean;
  ok: boolean;
  written: string[];
}

function makeFake(initialOk = true): FakeWritable {
  const written: string[] = [];
  const fake: FakeWritable = {
    ok: initialOk,
    written,
    write(text) {
      written.push(text);
      return fake.ok;
    },
  };
  return fake;
}

function evt(type: ScanEvent['type'], id = 0, extra: object = {}): ScanEvent {
  return { id, type, runId: 1, data: extra, ts: 0 };
}

describe('createBackpressuredWriter', () => {
  it('writes through immediately while not paused', () => {
    const fake = makeFake(true);
    const w = createBackpressuredWriter({
      writable: fake,
      serialize: (e) => e.type,
    });
    w.send(evt('phase'));
    w.send(evt('hashed'));
    expect(fake.written).toEqual(['phase', 'hashed']);
    expect(w.isPaused()).toBe(false);
  });

  it('flips to paused when write returns false', () => {
    const fake = makeFake(false);
    const w = createBackpressuredWriter({
      writable: fake,
      serialize: (e) => e.type,
    });
    w.send(evt('phase'));
    expect(w.isPaused()).toBe(true);
  });

  it('coalesces hashed events while paused — only the latest survives', () => {
    const fake = makeFake(false);
    const w = createBackpressuredWriter({
      writable: fake,
      serialize: (e) => `${e.type}:${e.id}`,
    });
    w.send(evt('phase', 1));
    expect(w.isPaused()).toBe(true);

    // Three hashed events fired during the paused window.
    w.send(evt('hashed', 2));
    w.send(evt('hashed', 3));
    w.send(evt('hashed', 4));
    expect(w.pendingDepth()).toEqual({ queued: 0, coalesced: true });

    // Drain — exactly one hashed should land (the most recent).
    fake.ok = true;
    w.onDrain();
    expect(fake.written).toEqual(['phase:1', 'hashed:4']);
    expect(w.isPaused()).toBe(false);
  });

  it('queues non-coalescing events in arrival order while paused', () => {
    const fake = makeFake(false);
    const w = createBackpressuredWriter({
      writable: fake,
      serialize: (e) => `${e.type}:${e.id}`,
    });
    w.send(evt('phase', 1)); // triggers paused
    w.send(evt('discovered', 2));
    w.send(evt('classified', 3));
    w.send(evt('done', 4));
    expect(w.pendingDepth().queued).toBe(3);

    fake.ok = true;
    w.onDrain();
    expect(fake.written).toEqual([
      'phase:1',
      'discovered:2',
      'classified:3',
      'done:4',
    ]);
  });

  it('drains queue first, then the coalesced pending event', () => {
    const fake = makeFake(false);
    const w = createBackpressuredWriter({
      writable: fake,
      serialize: (e) => `${e.type}:${e.id}`,
    });
    w.send(evt('phase', 1)); // pause
    w.send(evt('hashed', 2));
    w.send(evt('discovered', 3));
    w.send(evt('hashed', 4)); // coalesces, replaces 2

    fake.ok = true;
    w.onDrain();
    // FIFO queue: phase:1 (the one that triggered paused), discovered:3.
    // Then the coalesced hashed:4.
    expect(fake.written).toEqual(['phase:1', 'discovered:3', 'hashed:4']);
  });

  it('re-pauses mid-drain if the writer returns false again, leaving the rest queued', () => {
    const fake = makeFake(false);
    const w = createBackpressuredWriter({
      writable: fake,
      serialize: (e) => `${e.type}:${e.id}`,
    });
    // Send 5 items: the first goes through writeRaw and trips paused;
    // the remaining 4 get queued.
    w.send(evt('phase', 1));
    w.send(evt('discovered', 2));
    w.send(evt('classified', 3));
    w.send(evt('done', 4));
    w.send(evt('aborted', 5));
    expect(w.pendingDepth().queued).toBe(4);

    // Drain returns true for the first two writes, then flips back to false
    // on the third — leaving aborted:5 still in the queue.
    let writes = 0;
    fake.write = function (text: string) {
      fake.written.push(text);
      writes += 1;
      return writes < 3;
    };
    w.onDrain();
    expect(fake.written).toEqual([
      'phase:1', // wrote during the original send before paused flipped
      'discovered:2',
      'classified:3',
      'done:4', // this is the call that returned false → paused=true
    ]);
    expect(w.isPaused()).toBe(true);
    expect(w.pendingDepth().queued).toBe(1); // aborted:5 still queued
  });

  it('dispose() drops pending state', () => {
    const fake = makeFake(false);
    const w = createBackpressuredWriter({
      writable: fake,
      serialize: (e) => e.type,
    });
    w.send(evt('phase'));
    w.send(evt('hashed'));
    w.send(evt('done'));
    expect(w.pendingDepth().queued).toBeGreaterThan(0);

    w.dispose();
    expect(w.pendingDepth()).toEqual({ queued: 0, coalesced: false });
  });

  it('a throwing writable does not bubble out — caller handles cleanup', () => {
    const fake: FakeWritable = {
      ok: true,
      written: [],
      write() {
        throw new Error('socket gone');
      },
    };
    const w = createBackpressuredWriter({
      writable: fake,
      serialize: (e) => e.type,
    });
    expect(() => w.send(evt('phase'))).not.toThrow();
  });
});
