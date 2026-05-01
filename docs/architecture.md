# Architecture

Single Node 20 process. Fastify serves a React SPA at `/` and a REST + SSE
API under `/api`. State lives in a `better-sqlite3` database inside
`<target_root>/.dedupe/`.

## Process model

```
┌─────────────────────────────────────────────────────────────────────┐
│ Node process                                                        │
│                                                                     │
│  ┌──────────┐    HTTP+SSE    ┌──────────────┐                       │
│  │  React   │◀──────────────▶│   Fastify    │                       │
│  │  SPA     │   /api/*, /    │   (server/)  │                       │
│  └──────────┘                └──────┬───────┘                       │
│                                     │                               │
│                              ┌──────▼────────┐                      │
│                              │ Orchestrator  │ one job at a time:   │
│                              │ scanJob       │ scan | quarantine    │
│                              │ quarantineJob │ purge | restore      │
│                              │ + mutex       │ (withMutationLock)   │
│                              └──┬─────┬───┬──┘                      │
│                                 │     │   │                         │
│                  ┌──────────────┘     │   └─────────────┐           │
│                  │                    │                 │           │
│            ┌─────▼─────┐        ┌─────▼─────┐     ┌─────▼─────┐     │
│            │ Scanner   │        │ Classifier│     │ Mover     │     │
│            │ walker +  │        │ cruft +   │     │ quarantine│     │
│            │ hasher    │        │ dedup +   │     │ restore   │     │
│            │ (main     │        │ name-     │     │ purge     │     │
│            │  thread)  │        │ collision │     │ reconcile │     │
│            └─────┬─────┘        └─────┬─────┘     └─────┬─────┘     │
│                  │                    │                 │           │
│                  └──────────┬─────────┴─────────────────┘           │
│                             │                                       │
│                       ┌─────▼──────┐         ┌──────────────────┐   │
│                       │   SQLite   │────────▶│ audit.jsonl      │   │
│                       │  state.db  │         │ (append-only)    │   │
│                       │   (WAL)    │         └──────────────────┘   │
│                       └────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
```

The diagram is the truth: there is one process, one DB connection, one
hashing pool (currently single main-thread worker — see
[decisions/0006-fast-glob-deviation.md](decisions/0006-fast-glob-deviation.md)
and ROADMAP backlog #13), and one mover at a time (serialized by
`withMutationLock`, [src/orchestrator/mutex.ts](../src/orchestrator/mutex.ts)).

## Module map (what lives where)

| Layer | Path | Purpose |
|-------|------|---------|
| Boot | [src/main.ts](../src/main.ts) | Resolves `target_root`, opens DB, runs migrations, runs the target-sentinel guard, runs reconcile, starts Fastify. |
| DB | [src/db/index.ts](../src/db/index.ts) | `openDb()`, `migrate()`, `Db` interface (Drizzle `q` + raw `client`). |
| DB schema | [src/db/schema.ts](../src/db/schema.ts) + [src/db/migrations/](../src/db/migrations/) | Drizzle table defs; SQL migrations are generated, not handwritten. |
| DB queries | [src/db/queries.ts](../src/db/queries.ts) | Every typed query the rest of the code uses. **Always** add new queries here, never inline. |
| Target identity | [src/target/sentinel.ts](../src/target/sentinel.ts), [src/target/guard.ts](../src/target/guard.ts) | The UUID gate. See [safety-model.md](safety-model.md). |
| Paths | [src/paths/](../src/paths/) | `relpath` (rel-path normalization + `isPathWithin`), `winLong` (long-path prefix), `platform` (OS detection). |
| Config | [src/config/](../src/config/) | Zod schema, loader/patcher, gated keys. See [config.md](config.md). |
| Scanner | [src/scanner/](../src/scanner/) | Discover collections, walk + hash, populate `file` rows. |
| Hasher | [src/hasher/](../src/hasher/) | Streaming SHA-256, `HasherPool` (currently main-thread; API-shaped for a future worker). |
| Classifier | [src/classifier/](../src/classifier/) | Cruft → dedup → name-collision → keep. See [classifier.md](classifier.md). |
| Presets | [src/presets/](../src/presets/) | Built-in presets (Samsung, Minimal). Zod-validated; seeded on boot. |
| Mover | [src/mover/](../src/mover/) | The destructive surface. **Read [safety-model.md](safety-model.md) before changing**. |
| Orchestrator | [src/orchestrator/](../src/orchestrator/) | `scanJob`, `quarantineJob`, `runStore` (in-memory cache), `mutex`, `sanityGuard`. |
| Server | [src/server/](../src/server/) | Fastify app, routes, SSE bus + backpressure, static serving. |
| Audit | [src/audit/log.ts](../src/audit/log.ts) | `audit.jsonl` writer (`appendAudit`). |
| Web | [web/](../web/) | Vite + React SPA. See [api.md](api.md) for the wire it consumes. |

## End-to-end data flow

### Scan → dry-run report

```
POST /api/scans
   │
   ▼
runScanJob (orchestrator/scanJob.ts)
   │
   ├─ loadConfig → presetName, dryRun
   ├─ DryRunGateError if opts.dryRun=false but cfg.dry_run=true
   ├─ createRun('scan', dryRun)
   ├─ onRunCreated(runId) ──▶ EventBus.registerCancellable
   │
   ├─ scanAll (scanner/index.ts)
   │    ├─ syncCollectionsTable (filters dot-prefix dirs)
   │    ├─ for each collection:
   │    │    ├─ walkCollection (fast-glob + a sync BFS for unreadable subtrees)
   │    │    ├─ throw UnreadableSubtreeError if any subtree is EACCES/EPERM
   │    │    ├─ emit `discovered` SSE event
   │    │    ├─ for each file:
   │    │    │    ├─ cache hit (size + mtime_ms unchanged + hash present) → reuse
   │    │    │    ├─ else → upsert with NULL hash, then hash + setFileHash
   │    │    │    └─ emit `hashed` SSE event
   │    │    └─ emit `collection_done`
   │    └─ deleteStaleFiles (last_seen_run < runId) — full scans only
   │
   ├─ classifyAll (classifier/rules.ts)
   │    ├─ cruft pass (whitelist always wins)
   │    ├─ dedup pass (path-priority within, primary-wins across)
   │    └─ name-collision pass (cross-collection, hashes differ)
   │
   ├─ insertReviewItem rows (review_item table)
   ├─ checkSanityGuard → SanityGuardResult
   ├─ writeReport (.dedupe/reports/<runId>.json)
   ├─ rememberScan (in-memory cache, MAX 10 entries)
   ├─ setRunStatus('completed')
   └─ emit `done` SSE event
```

### Quarantine (the destructive flow)

```
POST /api/quarantine/run  body: { scanRunId, ignoreSanityGuard? }
   │
   ▼
withMutationLock (FIFO mutex; serialises all destructive ops)
   │
   ▼
runQuarantineJob (orchestrator/quarantineJob.ts)
   │
   ├─ loadConfig → cfg.dry_run
   ├─ DryRunGateError if cfg.dry_run=true
   ├─ checkSanityGuard → SanityGuardError unless ignoreSanityGuard
   ├─ createRun('quarantine', dryRun=false)
   │
   ├─ executeQuarantine (mover/quarantine.ts)
   │    │  for each PlannedAction (in order):
   │    │    1. lstatSync src; ENOENT → drop file row, audit, skip
   │    │    2. re-hash src; mismatch → audit, skip
   │    │    3. compute uniqueDest under .dedupe-trash/<ts>-run-<id>/...
   │    │    4. mkdir -p dest parent
   │    │    5. INSERT planned action row
   │    │    6. fs.renameSync src → dest
   │    │    7. lstatSync dest; size-mismatch → tryRestore + mark error
   │    │    8. UPDATE executed_at + verified_at
   │    │    9. DELETE file row
   │    │
   │    └─ empty-dir sweep (deepest-first; only dirs still empty)
   │
   ├─ setRunStatus('completed')
   └─ appendAudit('quarantine_complete', summary)
```

### Restore / Purge

Both gated by `withMutationLock`. Restore re-verifies the quarantined hash,
checks occupancy at the original path, optionally writes to a sidecar.
Purge is `unlinkSync` only inside `.dedupe-trash/` after `retentionDays`,
with `realpathSync` symlink defense. See [api.md](api.md).

### Crash recovery

On boot, `reconcilePending` ([src/mover/reconcile.ts](../src/mover/reconcile.ts)):

1. Marks any `running` runs from a previous process as `crashed`.
2. For each pending action (`executed_at IS NULL AND error IS NULL`),
   verifies the dest by re-hashing and either marks `executed` or `error`.
   **Never re-renames.**

This makes the mover idempotent across kill -9 / power loss.

## Concurrency model

- **One scan / mover at a time** — destructive ops grab `withMutationLock`,
  `POST /api/scans` does not (only one scan at a time is enforced socially
  by the UI, not the server — see [known-gaps.md](known-gaps.md)).
- **DB is synchronous** — `better-sqlite3` calls block the event loop, by
  design (see [decisions/0005-sync-better-sqlite3.md](decisions/0005-sync-better-sqlite3.md)).
- **Hashing is currently main-thread.** `HasherPool` has the API shape of a
  worker pool so it can swap to `worker_threads` later. ROADMAP backlog #13.
- **SSE backpressure** — see [src/server/events/backpressure.ts](../src/server/events/backpressure.ts).
  `hashed` events coalesce; everything else queues FIFO.

## Where IDs come from

- `target.target_id_uuid` — `crypto.randomUUID()` on first run, written to both
  the DB row and `<target_root>/.dedupe/target-id.txt`.
- `run.id`, `quarantine_action.id`, `review_item.id` — SQLite AUTOINCREMENT.
- SSE event id — monotonic, in-memory counter on `EventBus`.

## What's deliberately not here

- **No worker_threads** in the runtime path yet (only HasherPool's API shape).
- **No Electron** — local web UI in the browser instead.
- **No Playwright in CI** — unit/integration/contract/property cover the
  safety-critical surface; UI-only flows are tested with React Testing Library.
- **No third-party glob lib for path matching** — `globMatch` in
  [classifier/cruft.ts](../src/classifier/cruft.ts) is hand-rolled,
  single-segment only (no `**`).

See `decisions/` for rationale.
