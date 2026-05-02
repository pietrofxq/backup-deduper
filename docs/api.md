# API reference

All routes live under `/api/`. The SPA is served at `/`. Validation is
zod-based via `fastify-type-provider-zod`; both request and response are
schema-checked, and the contract test
([tests/contract/api.test.ts](../tests/contract/api.test.ts)) is the
**single source of truth** for the wire shape.

> When you add or change a route, update this doc in the same diff. Drift
> here breaks the apiClient on the frontend (which duplicates types — see
> [decisions/0010-web-types-not-shared.md](decisions/0010-web-types-not-shared.md)).

## Index

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/health` | liveness |
| GET    | `/api/config` | full config (zod-validated) |
| PUT    | `/api/config` | partial update; rejects gated keys with 400 |
| POST   | `/api/config/disable-dry-run` | type-to-confirm gate |
| GET    | `/api/collections` | list collections |
| POST   | `/api/collections/primary` | mark a collection primary |
| GET    | `/api/presets` | list presets |
| GET    | `/api/scans` | last 50 runs |
| GET    | `/api/scans/:id` | one run + cached report (or null) |
| POST   | `/api/scans` | start a scan synchronously |
| POST   | `/api/scans/:id/cancel` | abort an in-flight scan |
| GET    | `/api/quarantine` | active quarantine actions, optionally filtered by `runId` |
| POST   | `/api/quarantine/run` | execute classified actions for a scan run |
| POST   | `/api/quarantine/restore` | bulk-restore by action ids |
| POST   | `/api/quarantine/purge` | dry-run or real purge |
| GET    | `/api/audit` | paginated audit log + reasons |
| GET    | `/api/review` | review items by status |
| POST   | `/api/review/:id/decision` | record a review decision (only `kept_both` wired in v1) |
| GET    | `/api/events` | SSE stream — see below |

## Error envelope

All routes that hand-roll a 4xx return `{ error: string }`. Routes that need
a discriminator add a `kind` field:

```json
{ "error": "<message>", "kind": "dry_run_gate" | "sanity_guard" | "unreadable_subtree" | "unknown_preset" | "aborted" }
```

`SanityGuardError` includes the full `SanityGuardResult` under `guard`:

```json
{
  "error": "...",
  "kind": "sanity_guard",
  "guard": {
    "passed": false,
    "primaryFiles": 12345,
    "primaryBytes": 123456789,
    "plannedFiles": 8000,
    "plannedBytes": 90000000,
    "filesPct": 0.65,
    "bytesPct": 0.73,
    "reason": "files 65.0% > 50% and bytes 73.0% > 70%",
    "code": "pct_exceeded"
  }
}
```

`code` is a stable identifier for the failure mode — `'no_primary_set'`
when no primary collection is set and at least one action would fire (M15
fail-closed), or `'pct_exceeded'` when the planned actions exceed the
configured percentage limits. `null` when `passed === true`. The UI
branches on `code` instead of parsing `reason` prose.

`UnreadableSubtreeError` includes `unreadablePaths` and `collectionRelPath`.

## CORS

[src/server/index.ts:23–28](../src/server/index.ts) — only `localhost:5173`,
`127.0.0.1:5173`, `localhost:4173`, `127.0.0.1:4173`. Credentials disabled.
This is a deliberate localhost-only policy; see
[decisions/0007-localhost-cors.md](decisions/0007-localhost-cors.md).

## Health

```
GET /api/health  →  { ok: true }
```

## Config

```
GET /api/config  →  Config           (full object, see config.md)
PUT /api/config  body: Partial<Config>  →  Config | { error }     400 on gated key
```

`PUT` rejects any key in `GATED_CONFIG_KEYS` (currently `dry_run`,
`dry_run_disabled_at`) at the zod `.strict()` layer; defense-in-depth in
`patchConfig` ([src/config/loader.ts](../src/config/loader.ts)) throws
`GatedConfigKeyError` if it ever reaches the service.

```
POST /api/config/disable-dry-run  body: { phrase: string }
   200  →  { ok: true, config: Config }
   400  →  { error: "Wrong confirmation phrase. Type exactly: I have reviewed the dry-run report" }
```

The phrase is `CONFIRMATION_PHRASE` in
[src/config/schema.ts](../src/config/schema.ts).

## Collections

```
GET  /api/collections   →  CollectionRow[]
POST /api/collections/primary  body: { id: number }   →  Ok
```

The partial unique index `idx_collection_one_primary` makes "two primaries"
a constraint violation at the DB level — the route relies on that.

## Presets

```
GET /api/presets  →  Preset[]
```

Built-in presets (`Samsung Android phone backup`, `Minimal`) are seeded on
boot. To add another, see [workflows/adding-a-preset.md](workflows/adding-a-preset.md).

## Scans

### POST /api/scans

```
POST /api/scans  body: { presetName?: string, dryRun?: boolean }
```

Synchronous: blocks until scan completes. **Use SSE** (`/api/events`) for
progress while this is in flight, or open a second connection. The route
keeps `await runScanJob` blocking by design — see
[decisions/0008-in-memory-runStore.md](decisions/0008-in-memory-runStore.md).

Responses:

| status | shape |
|--------|-------|
| 200 | `{ runId, reportPath, report: DryRunReport }` |
| 400 | `{ error, kind: 'dry_run_gate' }` if you ask for `dryRun=false` while persisted `cfg.dry_run=true` |
| 404 | `{ error, kind: 'unknown_preset' }` |
| 409 | `{ error, kind: 'unreadable_subtree', unreadablePaths: string[], collectionRelPath: string }` |
| 409 | `{ error, kind: 'aborted' }` after `POST /scans/:id/cancel` |

`DryRunReport` shape lives in
[src/orchestrator/scanJob.ts:54](../src/orchestrator/scanJob.ts) and
[src/server/schemas.ts](../src/server/schemas.ts).

### POST /api/scans/:id/cancel

Flips the `AbortController` registered on the event bus. The orchestrator
polls `signal.aborted` between hashed files and at every phase boundary.

```
200 → { ok: true, runId: number }
404 → { error: 'no in-flight scan with runId=…' }
```

## Quarantine

### GET /api/quarantine?runId=N

Returns active actions (`executed_at IS NOT NULL AND restored_at IS NULL AND
purged_at IS NULL`). With `runId`, scoped to that run.

### POST /api/quarantine/run

```
body: { scanRunId: number, ignoreSanityGuard?: boolean }
200  →  { runId, summary: QuarantineSummary, guard: SanityGuardResult }
400  →  { error, kind: 'dry_run_gate' }
400  →  { error, kind: 'sanity_guard', guard: SanityGuardResult }
404  →  { error: 'scan result not found in cache; re-run /api/scans first…' }
```

Reads the scan's `actions` and `emptyDirActions` from the **in-memory**
`runStore` — a server restart clears that cache. The 404 message tells the
user to re-run the scan. See
[decisions/0008-in-memory-runStore.md](decisions/0008-in-memory-runStore.md).

Goes through `withMutationLock`.

### POST /api/quarantine/restore

```
body: { actionIds: number[] (≥1), allowSidecar?: boolean = false }
200  →  { runId, outcomes: Array<{ actionId, outcome: RestoreOutcome }> }
```

`RestoreOutcome` is one of:

```
{ kind: 'restored', finalPath }
{ kind: 'restored_sidecar', finalPath, reason }
{ kind: 'skipped', reason }
{ kind: 'errored', error }
```

Goes through `withMutationLock`.

### POST /api/quarantine/purge

```
body: { dryRun?: boolean = true }
200  →  PurgeSummary
```

`PurgeSummary`: `{ runId, eligible, purgedFiles, purgedBytes, emptyTrashDirsRemoved, errored, dryRun }`.

Retention is `cfg.retention_days` (default 30; range 1–365). Goes through
`withMutationLock`.

## Audit

```
GET /api/audit?
    runId=…
    & reason=…
    & after=ISO_DATETIME
    & before=ISO_DATETIME
    & limit=1..500   (default 100)
    & offset=≥0      (default 0)
```

Response: `{ items: AuditRow[], total, limit, offset, reasons: string[] }`.
The `reasons` array is **unfiltered** (so the UI dropdown shows all
historical reasons regardless of current filter).

## Review

```
GET /api/review?status=open|kept_both|quarantined_a|quarantined_b|all
                     (default 'open')
   →  ReviewItemRow[]
POST /api/review/:id/decision  body: { decision: 'kept_both' }
   →  Ok
```

In v1 only `kept_both` is accepted. Side-quarantine decisions are Phase 2.

## SSE: GET /api/events

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Initial frame on connect: `: connected\n\n`. Heartbeat every 15 s:
`: heartbeat <epoch_ms>\n\n` (SSE comment — silently ignored by `EventSource`,
keeps proxies awake).

### Frame format

```
id: <monotonic int>
event: <type>
data: <single-line JSON>

```

The blank line at the end is the SSE record terminator.

`event` types:

| type | when |
|------|------|
| `phase` | `{ phase: 'started' \| 'scan' \| 'classify' \| 'report' \| 'execute' \| 'done' }` |
| `discovered` | end of walk for a collection: `{ collection, files }` |
| `hashed` | per-file: `{ collection, relPath, index, total }` (coalesced under backpressure) |
| `collection_done` | `{ summary: CollectionScanSummary }` |
| `classified` | `{ actions, reviewPairs, emptyDirs }` |
| `done` | `{ totalActions, totalBytes, reviewPairs, sanityGuardPassed, reportPath }` |
| `aborted` | `{ reason }` (after `/cancel`) |
| `failed` | `{ error }` |
| `replay_lost` | client's `Last-Event-ID` is older than the bus's 200-event ring buffer; refetch state |

The envelope always includes `runId` and `ts`. Any object payload merges
into the envelope; primitive payloads land under `value`. See
[src/server/routes/events.ts:65–82](../src/server/routes/events.ts).

### Reconnect with replay

`EventSource` automatically sends `Last-Event-ID: <last id>`. The bus
replays anything still in its buffer; if the requested id is older than
`oldest - 1`, it sends a synthetic `replay_lost` event so the client knows
to refetch state.

### Backpressure

[src/server/events/backpressure.ts](../src/server/events/backpressure.ts)
wraps `reply.raw`. If `write()` returns `false`:

- `hashed` events **coalesce** (latest wins).
- everything else **queues** in arrival order — state-changing frames
  (`phase`, `done`, `aborted`, `failed`) are never dropped.

## Where the contract lives

Source of truth, in order of priority:

1. [tests/contract/api.test.ts](../tests/contract/api.test.ts) — runs Fastify
   in-process via `.inject()`.
2. [src/server/schemas.ts](../src/server/schemas.ts) — response zod schemas.
3. The route file: [src/server/routes/](../src/server/routes/).

The web client deliberately does **not** import server schemas — see
[decisions/0010-web-types-not-shared.md](decisions/0010-web-types-not-shared.md).
