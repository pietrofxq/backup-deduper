import { describe, expect, it } from 'vitest';
import { withMutationLock } from '../../src/orchestrator/mutex.js';

describe('withMutationLock', () => {
  it('serialises concurrent callers', async () => {
    const events: string[] = [];
    const slow = (label: string, ms: number) =>
      withMutationLock(async () => {
        events.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, ms));
        events.push(`${label}:end`);
        return label;
      });

    const results = await Promise.all([slow('A', 30), slow('B', 10), slow('C', 5)]);
    expect(results).toEqual(['A', 'B', 'C']);
    // FIFO: A's end must precede B's start, B's end must precede C's start.
    expect(events).toEqual([
      'A:start',
      'A:end',
      'B:start',
      'B:end',
      'C:start',
      'C:end',
    ]);
  });

  it('releases the lock when fn throws', async () => {
    await expect(
      withMutationLock(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The next caller must still run — if the lock leaked, this would hang.
    const result = await withMutationLock(async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('returns sync function results without an extra microtask hop', async () => {
    const result = await withMutationLock(() => 42);
    expect(result).toBe(42);
  });
});
