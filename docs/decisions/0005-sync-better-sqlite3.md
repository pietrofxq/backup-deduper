# 0005 — `better-sqlite3` synchronous API as a feature, not a bug

**Status:** Accepted
**Date:** 2024-02
**Touches:** [src/db/index.ts](../../src/db/index.ts), all of [src/db/queries.ts](../../src/db/queries.ts)

## Context

Two SQLite bindings dominate the Node ecosystem:

- `sqlite3` (async, callback/promise API).
- `better-sqlite3` (synchronous, blocks the event loop).

Conventional wisdom says async wins because it doesn't block the loop.
For a high-throughput web service that's right; for a desktop dedupe
tool with one user it's not.

## Decision

Use `better-sqlite3` and treat its synchronous nature as a feature:

- Transactions compose with the mover's sequential loop. `db.client.transaction(() => …)` is just a callback; the file rename inside it commits or rolls back atomically with the row insert.
- No async lifecycle to manage. No "did the connection close before this query landed?" race.
- We get `synchronous=FULL` durability ([0004](0004-two-phase-commit-mover.md)) without paying for an extra round-trip per call.

The cost — blocking the event loop on `~ms` queries — is tolerable because:

- The server has one user. Concurrent request count is 1, maybe 2 (a
  scan + an SSE feed).
- Hashing already runs synchronously on the main thread (M11 made this
  explicit; ROADMAP #13 will move it to a worker if profiling motivates).
- Fastify routes that touch the DB are short — the longest-running ones
  (`/api/scans`) chunk their work explicitly and yield via the
  AbortSignal poll between hashed files.

## Consequences

Better:

- Transactional code reads like sync code:
  ```ts
  db.client.transaction(() => {
    insertPlannedAction(db, ...);
    fs.renameSync(...);
    markActionExecuted(db, ...);
  })();
  ```
  No promise composition, no error-handling for half-applied state.
- Easy to reason about crash recovery: each top-level call either commits
  or doesn't.
- Drizzle's typed query builder works on top of `better-sqlite3` without
  glue.

Worse:

- A long-running query (we don't have any) would freeze SSE feeds during
  its duration.
- Cannot run `db.q` from inside a `worker_threads` worker without sharing
  the connection. We don't currently need to.

## Alternatives considered

- **`sqlite3` (node-sqlite3)** — async, callbacks/promises. Rejected:
  composing transactions with an `fs.renameSync` requires either turning
  the whole loop async or interleaving sync fs with async DB, both of
  which are awkward. Crash recovery becomes "did the promise chain
  reject before or after the rename?".
- **Drizzle's libSQL/PostgreSQL backends** — overkill; we run on a single
  desktop with one user.
- **Pure JS SQLite** (`sql.js`, etc.) — no real persistence story.
