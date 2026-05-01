/**
 * Process-wide mutex serialising destructive filesystem operations.
 *
 * Two HTTP requests can land on the server simultaneously — e.g. a button
 * double-click that fires both `/quarantine/run` and `/quarantine/restore`,
 * or a stuck client retrying `/quarantine/purge`. Without serialisation,
 * these can race each other: the same action row could be both restored
 * and purged, or two restores could both observe "occupant absent" and
 * both rename their copies into place.
 *
 * Scope: per-process. We only hold one server in flight at a time, so an
 * in-memory mutex is sufficient. SQLite's WAL writer-lock is a useful
 * second line of defense for any DB write contention but does NOT
 * synchronise the surrounding filesystem moves. That's what this lock is
 * for.
 *
 * The mutex is FIFO — calls are queued and resolved in arrival order.
 * Each waiter receives a `release()` token. Forgetting to call release
 * deadlocks the next waiter; callers MUST use `withMutationLock(fn)` so
 * release is wrapped in a try/finally.
 */

let chain: Promise<void> = Promise.resolve();

/**
 * Acquire the lock, run `fn`, release. Resolves to whatever `fn` returns.
 * Errors propagate (the lock is still released).
 */
export async function withMutationLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = chain;
  let release!: () => void;
  // Reassign chain BEFORE awaiting `previous`, so a second caller queues
  // behind us instead of behind whoever was already running.
  chain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
