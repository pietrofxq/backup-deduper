# Roadmap

Derived from [PLAN.md](./PLAN.md). Milestones are sequential — each builds on the previous one's invariants. Don't skip ahead.

The codebase is cross-platform (develop on Linux/macOS/Windows). Runtime targets all three but is tuned for Windows since that's where the user's primary data lives.

## Status legend

- ✅ delivered and locked in by tests
- 🟡 partial — see notes
- ⬜ not started
- ⛔ deviation from original plan (with rationale)

## v1 milestones

### ✅ M1. Skeleton + DB + target-sentinel guard
- ✅ `package.json`, `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`), `vitest.config.ts`.
- ✅ `src/main.ts` boots; `src/db/migrate.ts` applies the initial migration.
- ✅ `src/target/sentinel.ts` reads/creates `<target_root>/.dedupe/target-id.txt` (built-in `crypto.randomUUID()`). The only shell call is a best-effort `attrib +H` on Windows to mark the `.dedupe` folder hidden; failures are swallowed.
- ✅ `src/target/guard.ts` refuses to start if the live UUID doesn't match `target.target_id_uuid` in the DB; logs the absolute path discrepancy when one occurs.
- ✅ `src/paths/platform.ts` detects OS once at startup; `winLong.ts` no-ops on POSIX.
- **Smoke:** ✅ app boots against an empty tmp dir, generates the sentinel + DB, refuses on a wrong-UUID mock.
- **Tests added:** ✅ unit — `targetGuard.test.ts`, `paths.test.ts` (Windows-only branches gated by `process.platform === 'win32'`); ✅ integration — `boot.test.ts`.

### ✅ M2. Scanner + hasher + cache
- ⛔ `src/scanner/walker.ts` — **deviation:** uses `fast-glob` (per user request to prefer long-trusted community dependencies) with `followSymbolicLinks: false`, `dot: true`, `stats: true`. The plan said hand-rolled `fs.opendir`; the wrapper still rejects symlinks via lstat defense and tracks empty dirs. One known regression: fast-glob's `suppressErrors:true` swallows per-dir errors instead of bubbling them into `walk.errors` — flagged in code review as a Suggestion.
- ✅ `src/scanner/stat.ts` — `safeStat` returning `null` on `ENOENT`.
- 🟡 `src/hasher/worker.ts` — **deviation:** hashing currently runs on the main thread (`src/hasher/sha256.ts` + `src/hasher/pool.ts`) with a worker-shaped `HasherPool` API so a `worker_threads` swap is a local change. Not a safety issue; flagged as a perf milestone in M9.
- ✅ `src/hasher/pool.ts` — single-worker queue with backpressure (currently main-thread; see above).
- ✅ `src/scanner/index.ts` — orchestrates walk → upserts `file` rows; cache key = (size, mtime_ms) per (collection_id, rel_path); files not seen in `last_seen_run` are deleted post-walk.
- **Smoke:** ✅ first scan of a tmp tree completes; second scan completes in ms (cache hit on unchanged files).
- **Tests added:** ✅ unit — `cache.test.ts` (stat-unchanged → reuse, stat-changed → re-hash, file-disappeared → row deleted); ✅ integration — `scanHappyPath.test.ts`.

### ✅ M3. Presets + classifier + dry-run reporting
- ✅ `src/presets/types.ts` (zod schema), `samsung-android.ts`, `minimal.ts`, `registry.ts`.
- ✅ `src/classifier/cruft.ts` — preset-driven path-pattern rules; whitelist checked first. `Android/media/` whitelist beats every cruft rule in the Samsung preset.
- ✅ `src/classifier/dedup.ts` — group by `sha256_hex`; within-collection canonical keeper via path priority; cross-collection primary-wins; deterministic lex tiebreak.
- ✅ `src/classifier/nameCollision.ts` — basename grouping cross-collection, hashes differ, emit pairs.
- ✅ `src/classifier/rules.ts` — top-level precedence: cruft → duplicate → name-collision → keep.
- ✅ Dry-run produces `<target_root>/.dedupe/reports/<run-id>.json` listing every planned action with reason + counts + bytes.
- ✅ No fs writes other than the report.
- **Tests added:** ✅ unit — `classifier.test.ts` (table-driven, every rule + boundary), `presets.test.ts` (each preset round-trips zod, whitelist behavior); ✅ integration — `dryRun.test.ts`.

### ✅ M4. Mover (quarantine) + reconcile + sanity guard + dry-run gate
- ✅ `src/mover/quarantine.ts` — two-phase commit: pre-flight stat → re-hash → INSERT planned row → `mkdir -p` dest parent → `fs.renameSync` → post-move verify → set `executed_at` + `verified_at` → DELETE file row.
- ✅ `src/mover/uniqueDest.ts` — collision suffix `(1)`, `(2)`...
- ✅ `src/mover/reconcile.ts` — startup: mark stale `running` runs as `crashed`; for each `executed_at IS NULL AND error IS NULL` action, distinguish 5 cases (dest match → executed; size/hash mismatch → error; dest missing+src present → error; both missing → error). Re-hashes the dest before flipping `executed_at`.
- ✅ `src/orchestrator/sanityGuard.ts` — abort if planned actions exceed 50% files or 70% bytes of the primary collection, unless explicitly overridden.
- ✅ Type-to-confirm gate ("I have reviewed the dry-run report") to disable dry-run for the first time. Persisted in `config` table. `PUT /config` is also fenced — gated keys (`dry_run`, `dry_run_disabled_at`, `sanity_guard_override`) are rejected at the schema layer with defense-in-depth in `patchConfig`.
- **Tests added:** ✅ integration — `crashRecovery.test.ts` (8 cases: dest-match-executed, size-mismatch, hash-mismatch, dest-missing+src-present, both-missing, idempotence, e2e no-op, abandoned-running runs marked crashed); ⬜ `lockedFile.test.ts` (Windows-only, deferred to M11); ⬜ `longPath.test.ts` (Windows-only, deferred to M11). ✅ Property — `safetyInvariant.test.ts` at `numRuns: 50` (currently `200` in stress runs); oracle-correctness regression test plants an orphan in `.dedupe-trash/` and asserts it's NOT counted as reachable.

### ✅ M5. Restore + purge
- ✅ `src/mover/restore.ts` — verify quarantine file still matches recorded hash → reconstruct current path from `(target.target_root_abs, collection, rel_path)` → refuse if target occupied with different content (offer `(restored)` sidecar) → rename back → re-upsert `file` row.
- ✅ `src/mover/purge.ts` — separate runner; deletes from `.dedupe-trash/` only entries with `executed_at + retention_days < now`. Never invoked by scans. Time-gated. Path-fenced to inside `<target_root>/.dedupe-trash/`; refuses anything else.
- ✅ Bulk-restore by action ids (single-run bulk-restore is a thin wrapper).
- **Tests added:** ✅ integration — `restore.test.ts` (5 cases: happy path, conflict-refusal, sidecar route, occupant-with-matching-hash, bulk), `purge.test.ts` (3 cases: too-young refusal, dry-run + real purge with future cutoff, refusal of out-of-trash paths).

### ✅ M6. API + API contract tests + minimal embedded UI
- ✅ `src/server/index.ts` — Fastify 5 boot with `fastify-type-provider-zod`. Routes typed end-to-end against inline zod `schema` blocks; auto request/response validation.
- ✅ Routes: `/health`, `/config` (with gated-key fence), `/collections`, `/presets`, `/scans`, `/scans/:id`, `/quarantine`, `/quarantine/run`, `/quarantine/restore`, `/quarantine/purge`, `/review`, `/review/:id/decision`, `/audit`.
- ⬜ `/events` SSE channel for scan progress — **deferred to M11** (the typed-progress-events plumbing exists in the orchestrator but isn't surfaced over HTTP yet).
- 🟡 `web/` — **deferred to M8–M11.** Currently a single embedded HTML/JS file at `src/server/static.ts` is served at `/` as a fallback. The full React + Vite + Tailwind + TanStack Query + TanStack Table SPA is its own milestone block below.
- **Tests added:** ✅ API contract — `tests/contract/api.test.ts` using Fastify `.inject()`. Covers route shapes (zod-validated requests + responses) and DB side-effects without HTTP sockets or browsers, including the gated-key refusal and the `kept_both`-only review decision.

### ✅ M7. CI matrix + safety hardening pass
- ✅ GitHub Actions matrix: `{ubuntu-latest, macos-latest, windows-latest}` × Node 20 + 22 (`.github/workflows/ci.yml`).
- ✅ All test layers green on each push: unit + integration + contract + property + typecheck. **89/89 tests pass.**
- ✅ Property test at `numRuns: 50` in CI; `npm run test:thorough` for `numRuns: 500` ad-hoc; nightly job at `numRuns: 500` against `main`.
- ✅ Drizzle ORM migration (`src/db/schema.ts` + `drizzle-kit generate`); fast-glob walker; `fastify-type-provider-zod` — three deliberate dependency swaps from earlier hand-rolled equivalents.
- ✅ Code-review hardening pass: closed 4 blockers (PUT /config gate, safety-invariant oracle, reconcile correctness, review-decision no-op).
- ⬜ Manual verification protocol from README executed against `<target_root>/test-collection/` — **release blocker; user-driven, not in CI.**
- ⬜ Switch `target_root` to the real `E:\` and run a dry-run on real data — **gated on M8–M12 UI.**

---

## Web UI build-out (M8–M12)

The full UI promised in PLAN.md was deferred during initial implementation in favor of getting the safety-critical engine + API right. These milestones replace the embedded single-file fallback at `src/server/static.ts` with the planned React app.

Each UI milestone follows the same shape: scaffolding → page → wiring → tests. The API surface is already done (M6); these milestones consume it.

### ✅ M8. Web app scaffold + design system

- ✅ `web/` — Vite 6 project, React 19, TypeScript strict + `noUncheckedIndexedAccess` (matches the server's tsconfig flags).
- 🟡 `web/src/main.tsx` + `web/src/App.tsx` shipped. Router **deferred to M9** — the M8 placeholder is a single page; TanStack Router lands when there are multiple pages to route between.
- ✅ Tailwind 4 wired via `@tailwindcss/vite`. Tokens (`--color-accent`, `--color-warning`, `--color-danger`) declared in `web/src/index.css`. Dark mode skipped.
- ✅ TanStack Query 5 + typed `web/src/lib/apiClient.ts`. ⛔ **Deviation:** response shapes are duplicated as plain TS interfaces in `apiClient.ts` rather than imported from `src/server/schemas.ts`. Reasoning is in the file's docstring — importing zod schemas would drag server-only deps (drizzle, better-sqlite3 transitively) into the web bundle and couple the two tsconfigs. The contract test (`tests/contract/api.test.ts`) is the single source of truth for the wire shape.
- ✅ Vite dev server proxies `/api/*` to Fastify on `:7777` (configurable via `SAFE_DEDUPE_PORT`). Fastify serves `web/dist/` at `/` via `@fastify/static@8` (bumped from 7 — required by Fastify 5).
- ✅ `npm run build:web` → `npm --prefix web run build` (tsc -b && vite build).
- ✅ `npm run dev` runs Fastify (tsx) and Vite concurrently via `concurrently`.
- ✅ **Server-side change:** every API route now lives under `/api`. `registerRoutes` wraps them in a Fastify plugin with `{prefix: '/api'}`. The contract tests, the embedded fallback UI, and the apiClient all hit `/api/*`.
- ✅ **CORS:** `@fastify/cors` registered with a localhost-only allowlist (`5173`/`4173`). Production is same-origin so CORS is a no-op there. Localhost-only by design — this tool reaches user data and must not be addressable from arbitrary web pages.
- ✅ **Backlog items closed in this milestone:**
  - #23 (response schemas missing) — added `src/server/schemas.ts` with response schemas for every route except the trivial `Ok`-shaped ones. Internal DB column names are now serialised through zod, not raw `JSON.stringify`.
  - #24 (`POST /quarantine/run` registered in scans.ts) — moved to `src/server/routes/quarantine.ts` where it belongs.
  - #28 (no CORS) — added (see above).
- ✅ **Tests added:** `web/src/lib/__tests__/apiClient.test.ts` — 7 cases, mocks fetch, asserts the `/api/*` URL prefix, JSON content-type, query-string serialisation, error handling via `ApiError`, and `baseUrl` override. All 106 server tests still green; web tests run separately via `npm run test:web`.
- ⬜ **Deferred to M9:** SPA-fallback for client-side routes (currently `/anything` 404s from `@fastify/static`). Not blocking M8 because the placeholder app has no router.

### ✅ M9. Dashboard + Settings pages

- ✅ **Layout shell.** `web/src/components/Layout.tsx` ships the desktop-app-feeling chrome: fixed-width sidebar with nav + status footer (target_root, UUID prefix), 56-px top bar with dry-run/live badge and active preset, content area with a max-width gutter. Auto-dark via `prefers-color-scheme` baked into CSS tokens; tabular-nums everywhere numbers live. Lucide icons, hairline borders, focus rings.
- ✅ **Routing.** `@tanstack/react-router` (code-based) with `/` → Dashboard and `/settings` → Settings. Pending nav items (`/quarantine`, `/audit`, `/review`) render disabled with a "soon" tag pointing at M10.
- ✅ **Dashboard.** Stat tiles (collections, files-last-scan, bytes-touched, last-run-age), a focused "Run a scan" panel with the primary-collection check + big lit Scan button, a Last-scan summary panel (sanity-guard verdict, counts-by-reason rows with byte-share %), an auto-discovered Collections list, and a recent-runs feed. Dry-run banner up top stays prominent until live mode is set.
- ✅ **Settings.** Four cards: Primary collection picker, Active preset (with rule/whitelist/priority counts under the dropdown), Retention + sanity-guard sliders (with dirty-state save button + inline validation 1..365), and Disable-dry-run with inline phrase-match (full M12 dialog still pending). Each mutation invalidates the right TanStack Query keys.
- ✅ **TanStack Query 5.** All reads via `useQuery` with the centralized `keys` map; mutations use `useMutation` and `qc.invalidateQueries(keys.X())` for stale-while-revalidate behavior. The Scan flow uses `qc.setQueryData` to seed the report into the cache before the refetch lands.
- ✅ **SPA fallback.** Fastify's `setNotFoundHandler` returns `web/dist/index.html` for non-`/api` 404s so a hard refresh on `/settings` works; `/api/*` 404s remain structured JSON.
- ✅ **Backlog items closed in this milestone:**
  - #12 (`boot()` DB-handle leak) — wrapped post-`openDb` boot work in try/catch so any throw before the server takes ownership closes the handle.
  - #26 (`discoverCollections` dot-dir skip undocumented) — added a docstring explaining why every dot-prefixed directory is filtered, not just `.dedupe*`.
- ✅ **Tests added:** `web/src/pages/__tests__/Dashboard.test.tsx` (5 cases: dry-run banner, live banner, collections render, Scan-now POST + summary, primary-required disabled state), `web/src/pages/__tests__/Settings.test.tsx` (6 cases: cards render, preset switch → PUT /config, retention/sanity-guard save patches, retention validation, exact-phrase dry-run gate, set-primary). Server suite gained two contract tests for the SPA fallback (HTML return for `/settings`, JSON 404 for unknown `/api/*`). Final tally: **108 server tests, 18 web tests — all green.**
- ⬜ **Deferred to later milestones:**
  - Backlog #21 (scan results held in memory; lost on restart) — bigger refactor; defer to M11.
  - Backlog #22 (`listAllActions` 1k-row cap, `/audit` truncation) — defer to M10 when the Audit page lands.

### ✅ M10. Quarantine + Audit Log + Review Queue pages

- ✅ **Quarantine.** Table over `/api/quarantine`. Columns: collection, rel-path, reason, size, planned/executed timestamps. Per-row Restore + bulk Restore via row selection. Purge eligible runs a dry-run preview banner first, then a second click confirms. CSV export and a refresh button on the page header.
- ✅ **AuditLog.** Server-side paginated table over `/api/audit`. Filters: run id, reason (dropdown populated from the response's `reasons` array), date range (after/before on `planned_at`). State-column badges distinguish quarantined / restored / purged / errored. Read-only.
- ✅ **ReviewQueue.** Table over `/api/review?status=open|kept_both|all`. Each row shows the basename plus both sides' (collection, rel-path, sha-prefix, size). Only "Keep both" is wired (v1) — the page surfaces an explainer about the Phase 2 side-quarantine flow.
- ✅ **`useTable` hook + `<DataTable>` primitive.** Hand-rolled (no `@tanstack/react-table` dep) — handles sort, pagination, row selection, CSV export. Quarantine + ReviewQueue use it; AuditLog reuses sort + columns but pages server-side. Reasoning: the surface needed is small enough that a new dep is more friction than help, and the column descriptors stay identical to TanStack Table's shape so a swap later is mechanical.
- ⛔ **Deviation:** the milestone said "TanStack Table on each page". We hand-rolled instead because the working set was modest (sort + paginate + select + CSV). The `ColumnDef<T>` shape mirrors TanStack Table's API so a swap is a mechanical lift if a real-data dataset ever motivates one.
- ✅ **Backlog item closed in this milestone:**
  - #22 (`listAllActions` 1k-row cap, `/audit` truncation) — replaced with `listAuditPage(db, filters, limit, offset)` returning `{items, total, limit, offset}`. Route gained `runId`, `reason`, `after`, `before`, `limit`, `offset` query params plus a `reasons` array in the response (distinct values, unfiltered, used by the UI dropdown without a second round-trip). Wire-shape change is breaking; the apiClient + contract test were updated together.
- ✅ **Routing.** `/quarantine`, `/audit`, `/review` are no longer "soon" placeholders — un-pended in `Layout.tsx`'s nav and registered in `router.tsx`.
- ✅ **Tests added:**
  - Web: `Quarantine.test.tsx` (5 cases: render, single restore, bulk restore via select-all, purge dry-run → confirm flow, sort toggle), `AuditLog.test.tsx` (5 cases: render, reason filter triggers refetch, runId filter, clear button resets, Next advances offset), `ReviewQueue.test.tsx` (3 cases: open-only by default, Keep both calls decideReview, status filter refetches).
  - Server: `tests/contract/api.test.ts` gained one test exercising `/audit`'s paginated envelope (items/total/limit/offset/reasons), reason filter, limit/offset pagination, and unknown-runId zero-result behavior.
  - Final tally: **111 server tests, 31 web tests — all green.**

### 🟡 M11. SSE progress + locked-file / long-path test gaps + safety hardening

- ✅ **SSE.** New route `GET /api/events` opens a server-sent-event stream (`src/server/routes/events.ts`). An in-process `EventBus` (`src/server/events/bus.ts`) holds a 200-event ring buffer and supports `Last-Event-ID` replay; misbehaving subscribers are isolated. Heartbeat every 15s; the route writes raw to `reply.raw` and never resolves so Fastify keeps the socket open. The `POST /api/scans` route now publishes `phase` / `discovered` / `hashed` / `classified` / `done` / `aborted` / `failed` events through the bus during execution.
- ✅ **Cancel.** `POST /api/scans/:id/cancel` flips the bus-registered `AbortController`. The orchestrator polls `signal.aborted` between hashed files and at every phase boundary; on abort, `setRunStatus(runId, 'aborted')` and `ScanAbortedError` is thrown. Mid-scan cancel races are handled gracefully (either side can win).
- ✅ **Dashboard live progress.** New `useScanEvents` hook (`web/src/hooks/useScanEvents.ts`) opens an `EventSource` against `/api/events` and surfaces `{phase, discovered, hashed, classified, finished, error}`. Dashboard's right-side panel becomes a live progress bar while a scan is in flight (replacing the "last scan" summary card); the primary action button swaps to "Cancel scan #N". Once `done` arrives, the panel reverts to the summary view.
- ⛔ **Deviation:** The `/api/scans` POST stays synchronous rather than turning into a 202+poll flow. The route's `await runScanJob` keeps blocking; the SSE channel is the *visualisation* layer, not the work-tracking layer. Reasoning: a sync POST keeps the existing `tests/contract/api.test.ts` shape stable (no async run-store rewrites) and avoids wiring two state machines for one operation.
- ✅ **Filling the M4 test gap.** `tests/integration/lockedFile.test.ts` + `tests/integration/longPath.test.ts` added. Both gated by `describe.skipIf(!isWindows)` — they run on Windows CI only. Linux/macOS CI sees them as 2 skipped tests, not 0 — the gate is visible.
- ✅ **Backlog items closed in this milestone:**
  - #5 (synchronous=NORMAL) — bumped to `synchronous=FULL`. The fsync cost is negligible at our commit volume; the safety dividend (corruption-free WAL across kernel panic / power loss) is essential for a tool that mediates destructive moves.
  - #10 (empty-dir removal not bottom-up) — sort `emptyDirs` by descending segment count before the rmdir loop. Deepest-first means siblings of a deleted parent never get spurious-ENOENT-skipped.
  - #17 (purge symlink defense) — `fs.realpathSync` collapses symlinks before the in-trash fence check, then re-fences. ENOENT is fine (falls through to the unlink which records "already gone").
  - #18 (db.q vs db.client) — docstring on the `Db` interface now spells out which is canonical.
  - #20 (1-second `executed_at` precision) — switched `markActionExecuted` to `strftime('%Y-%m-%d %H:%M:%f', 'now')`. Reconcile's (executed_at, verified_at) ordering disambiguation now works at sub-second granularity. The parser already accepted `.SSS` fractional seconds.
  - #29 (no in-process mutex on destructive ops) — new `withMutationLock` (`src/orchestrator/mutex.ts`) serialises `/api/quarantine/run`, `/api/quarantine/restore`, and `/api/quarantine/purge`. FIFO; release-on-throw. Tests in `tests/unit/mutex.test.ts`.
  - #30 (missing tests for `isPathWithin` / `uniqueDest` overflow) — `tests/unit/safetyGuards.test.ts` covers `isPathWithin` (parent-equals-child, sibling-prefix, escape-via-dotdot) and `uniqueDest` (walks suffixes past 100 collisions).
- ✅ **Tests added:** `tests/contract/events.test.ts` (4 cases: stream opens with `text/event-stream` headers, scan publishes events end-to-end, `Last-Event-ID` replays buffered events, cancel route races correctly with completion). `tests/unit/eventBus.test.ts` (8 cases). `tests/unit/mutex.test.ts` (3 cases). `tests/unit/safetyGuards.test.ts` (9 cases). The two Windows-only integration tests skip on Linux. Final tally: **136 server tests + 31 web tests, 2 Windows-only skipped on Linux.**
- ⬜ **Deferred to a later milestone:**
  - Backlog #6 (`insertPlannedAction` not in explicit transaction) — single insert; cosmetic without atomicity benefit. Defer.
  - Backlog #7 (stranded actions when `tryRestore` fails are invisible to reconcile) — they ARE visible (rows have `error` set), but should appear in a UI surface. Defer to a future audit-page enhancement.
  - Backlog #9 (empty-dir cruft sweep ignores preset whitelist) — needs a careful classifier rewrite; defer.
  - Backlog #11 (`path_prefix` unanchored against partial dir names) — schema-level fix risks breaking shipped presets. Defer.
  - Backlog #13 (hashing on a worker thread) — perf concern; defer until profiling on real data shows it matters.
  - Backlog #14 (fast-glob `suppressErrors:true`) — known limitation; defer.
  - Backlog #16 (purge UTC parsing) — already addressed by `parseSqliteDatetime` in `src/db/datetime.ts`. Closing.
  - Backlog #21 (in-memory scan-result store) — bigger refactor; defer.
  - Backlog #25 (cruft TOCTOU) — known limitation, document-only.
  - Backlog #27 (O(n²) name-collision groups) — defer until a pathologically large dataset is observed.

### ⬜ M12. Type-to-confirm dialog + UI safety polish

- **Type-to-confirm dialog.** Modal that requires the user to type `I have reviewed the dry-run report` exactly. Submit button disabled until match. Calls `POST /api/config/disable-dry-run`. Dialog state is a top-level Zustand or context store so it can be triggered from anywhere.
- **Safety affordances.**
  - Persistent dry-run banner that blocks the "Run quarantine" button until the gate is passed.
  - Sanity-guard trip dialog: when a scan reports `sanityGuard.passed === false`, show a red panel with the percent figures and an explicit "Override sanity guard for this run only" checkbox that re-enables the button.
  - "Show me 20 random rows per reason" link on the dry-run report panel — opens a sample table the user can spot-check against disk before confirming.
- **Single targeted Playwright test** for the type-to-confirm flow (mentioned in PLAN as the one UI flow that justifies E2E). Run only on Linux CI; a single browser, no matrix.
- **Tests added:** `web/tests/typeToConfirm.test.ts` (component-level), `tests/e2e/typeToConfirm.spec.ts` (Playwright, single test).

### ⬜ M13. Ship to real data

- Switch the embedded UI to a redirect to the React bundle; remove `static.ts`'s HTML fallback.
- Update README's first-run protocol with the real UI screenshots.
- Manual verification protocol on `<target_root>/test-collection/` — release blocker.
- Then and only then: switch `target_root` to the real `E:\` and run a dry-run on real data.

---

## Pre-ship hardening (M14–M18)

Surfaced by the docs structure pass; see [`docs/known-gaps.md`](./docs/known-gaps.md) for the full triage. These are sequenced **before** M13 (ship-to-real-data) because each closes a hole that becomes visible the moment the tool runs against the user's actual `E:\` data.

### ✅ M14. Documentation drift cleanup

Closed in PR `docs/ai-context-structure`. The seven doc/code drift items catalogued in [`docs/known-gaps.md`](./docs/known-gaps.md) §"Documentation drift" are all addressed:

- ✅ **D-1 pino / app.log.** README/PLAN updated to name the actual logger (Fastify default → stdout) and `audit.jsonl` as the persistent structured log. The `pino` direct dependency is left in `package.json` for now (Fastify pulls it in transitively; deleting the direct entry is a no-op for runtime behavior).
- ✅ **D-2 weekly DB snapshots.** Claim removed from both README and PLAN. Re-add only if/when the snapshot job ships.
- ✅ **D-3 config.json.** Removed from README's layout, removed from PLAN's runtime layout, and removed from the README first-run protocol. Config is in the SQLite `config` table.
- ✅ **D-4 migration filename.** PLAN's critical-files list now references `0000_initial.sql`.
- ✅ **D-5 README "not yet implemented" framing.** Rewritten to reflect the M11-shipped reality; "How to run" section updated with the actual `npm` scripts.
- ✅ **D-6 embedded HTML fallback.** README layout no longer references the embedded fallback; full code-side removal stays under M13 (ship-to-real-data).
- ✅ **D-7 AGENTS.md "five files".** Section renamed; PLAN's canonical list updated to enumerate every safety-critical file with a one-line note each.

### ✅ M15. Sanity guard fail-closed without primary

Closed: [`src/orchestrator/sanityGuard.ts`](./src/orchestrator/sanityGuard.ts) used to return `passed: true` vacuously when no primary collection was set ([`docs/known-gaps.md`](./docs/known-gaps.md) item SG-1) — a `target_root` with no primary had zero sanity-guarding. Now:

- ✅ `checkSanityGuard` returns `passed: false` with a new `code: 'no_primary_set'` field when `getPrimary(db)` is null **and** at least one action would fire. No-op runs (zero actions) still pass — the guard fires only when there's something to refuse.
- ✅ `SanityGuardResult.code` (`'no_primary_set' | 'pct_exceeded' | null`) lets the UI / API clients branch on a stable identifier instead of parsing `reason` prose. Wired through `src/server/schemas.ts` and `web/src/lib/apiClient.ts`.
- ✅ Dashboard surfaces a red banner — "No primary collection set — quarantine disabled" — until the user marks one. The last-scan summary swaps the trip-message header to "Quarantine refused — no primary set" when `code === 'no_primary_set'` (skipping the percentage-figures line that's irrelevant in that branch).
- ✅ `runQuarantineJob` throws `SanityGuardError` (carrying `guard.code === 'no_primary_set'`) — the existing `ignoreSanityGuard` override still bypasses, leaving an escape hatch for the user who knows what they're doing.
- ✅ Tests: `tests/unit/sanityGuard.test.ts` (3 cases — vacuous-no-actions pass, populated-no-primary fail-closed, primary-set-passes), `tests/integration/quarantine.test.ts` gained "M15 — sanity guard fails closed when no primary is set and actions are non-empty", `tests/contract/api.test.ts` gained "M15 — POST /quarantine/run with no primary set returns 400 sanity_guard with code=no_primary_set" (also asserts `ignoreSanityGuard=true` bypass), `web/src/pages/__tests__/Dashboard.test.tsx` gained 2 cases for banner show/hide. Final tally: **154 server tests, 33 web tests — all green.**

### ⬜ M16. Persist `runStore` to disk

ROADMAP backlog #21, promoted. The in-memory cache means a server restart between scan and quarantine forces a re-scan (15–25 minutes on the user's 155 GB dataset). For real-world ergonomics:

- Serialize `actions[]` and `emptyDirActions[]` as a typed JSON sidecar at `<target_root>/.dedupe/reports/<runId>-actions.json`.
- On `POST /api/quarantine/run` cache miss, fall back to loading from the sidecar before 404'ing.
- Honor sidecar TTL (e.g. 7 days; a much-older scan should be invalidated).
- Update [`docs/decisions/0008-in-memory-runStore.md`](./docs/decisions/0008-in-memory-runStore.md) to "Superseded by 0011".

### ⬜ M17. Audit-page surface for errored actions

ROADMAP backlog #7, promoted. When `tryRestore` fails or any action is stranded with `error` set, surface them in the audit UI — today they're invisible to reconcile (rows have `error` set, but the UI doesn't filter for them).

- Add an `errored` filter to `/api/audit`'s `state` enum.
- Add a red badge in the AuditLog page's state column.
- Add a contract test asserting an `error`-bearing row appears under that filter.

### ⬜ M18. Path-prefix anchoring

ROADMAP backlog #11, promoted. `path_prefix` cruft/whitelist patterns are matched with raw `startsWith` — `Android/data` over-matches `Android/database/foo`. Risk: silent over-classification.

- Enforce in the preset zod schema: `path_prefix` patterns must end with `/` (or be matched against `/`-delimited segments).
- Migration: scan all existing presets for offending patterns; rewrite or surface a warning.
- Update [`docs/classifier.md`](./docs/classifier.md) and [`docs/workflows/adding-a-preset.md`](./docs/workflows/adding-a-preset.md) §"anti-patterns" once the schema enforces it.

### ⬜ M19. Mover-side hashing on a worker

ROADMAP backlog #13 today covers the scanner pool only. The mover (`quarantine.ts:146`, `restore.ts:90`, `reconcile.ts:98`) calls `hashFileSync` on every action. For multi-GB files this stalls SSE and request handling — not blocking for the user's 155 GB dataset (median file size is small) but worth measuring under M13's manual verification.

- Move `hashFileSync` to a `worker_threads` pool so the event loop stays responsive during quarantine of large files.
- Profile first; defer the change if median quarantine wall-clock is acceptable.

### ⬜ M20. First-run install wizard

A guided first-launch flow so the user never hits the "no primary set" footgun (which M15 makes fail-closed) and never has to know that "active preset" is a config key. Sequenced **after** M9 (which shipped the picker components), M12 (type-to-confirm pattern), and M15 (sanity-guard fail-closed safety net), and **before** M13 (ship-to-real-data) — the wizard is the de-facto first contact with real data.

**Shape (chosen):** server-launched flow. The user keeps starting the tool with `TARGET_ROOT=…`; the wizard is purely the in-browser confirmation/picker step that runs on first connect. Rejected the in-app path-entry shape (would let an attacker who reaches `:7777` re-bind the sentinel/DB to a sensitive directory; not worth the safety surface vs. asking users to set the env var).

Steps:

- ⬜ **Wizard gate.** Add `wizard_completed_at: z.string().nullable().default(null)` to `ConfigSchema` ([src/config/schema.ts](./src/config/schema.ts)). Not gated — the wizard's `POST /api/wizard/complete` is the only writer. The `PUT /api/config` `.strict()` filter passes through non-gated keys, so no GATED_CONFIG_KEYS change.
- ⬜ **First-run detection.** `GET /api/health` (or a new `GET /api/wizard/status`) returns `{ wizardRequired: boolean }` based on `wizard_completed_at === null` AND `getPrimary(db) === null`. The SPA's root route redirects to `/wizard` when `wizardRequired` is true.
- ⬜ **`/wizard` page.** Four screens, single-page-stack; back/next not routes:
  1. **Confirm target.** Show the resolved absolute `target_root` (returned by `GET /api/health`), the sentinel UUID, the OS platform. The user types `confirm` to advance — same affordance as M12's type-to-confirm. Refusing here just means "stop the tool and re-launch with a different `TARGET_ROOT`".
  2. **Discovered collections.** Lists subfolders found by `discoverCollections` ([src/scanner/index.ts](./src/scanner/index.ts)). Read-only — collections are auto-discovered, not user-managed. Pre-flight summary: file counts via `GET /api/collections/preview` (new lightweight endpoint that runs `walkCollection` count-only, no hashing).
  3. **Pick primary.** Radio list of collections; calls `POST /api/collections/primary`. Required; cannot advance without selection. This is what makes M15's safety net invisible to first-time users.
  4. **Pick preset.** Dropdown over `GET /api/presets`; defaults to `Samsung Android phone backup`. Calls `PUT /api/config { active_preset }`. Shows rule/whitelist/priority counts under the dropdown (same component as M9's Settings card).
- ⬜ **Finish.** `POST /api/wizard/complete` sets `wizard_completed_at` and redirects to `/` (Dashboard). The Dashboard's existing dry-run banner takes over from there.
- ⬜ **Re-entry.** Settings page already exposes primary picker + preset dropdown (M9), so the wizard is genuinely one-time. No "redo wizard" button in v1; if the user really wants to, they delete `wizard_completed_at` from the `config` table by hand or use a hidden `POST /api/wizard/reset` (out of scope here).
- ⬜ **Persistence:** all already shipped — `config` KV (M1), `collection.is_primary` partial unique index (M1), zod-validated config (M6/M9). Only the new key `wizard_completed_at` is added.
- ⬜ **Tests:**
  - Server: contract test for `GET /api/wizard/status`, `POST /api/wizard/complete`, idempotence of complete, refusal to complete without primary.
  - Web: component tests for each step; snapshot of the redirect-to-wizard behavior.

**Out of scope for v1 wizard:**

- Multi-target_root management (Phase 2).
- Editing `target_root` from inside the app (would re-bind sentinel — out of scope; relaunch with a new env var).
- Custom presets or rule editors in the wizard (Settings can do this in Phase 2 as a JSON textarea; the wizard is happy-path only).

See also: [docs/workflows/install-wizard.md](./docs/workflows/install-wizard.md) for the implementation guide.

---

## Suggestion backlog from the post-implementation code review

These are the non-blocking items the M7 hardening pass surfaced. Tagged with the milestone where they should ship.

| # | File | Issue | Target |
|---|---|---|---|
| 5 | `src/db/index.ts:38` | `synchronous=NORMAL` — switch to FULL for power-loss durability | ✅ M11 |
| 6 | `src/mover/quarantine.ts:170-178` | Wrap `insertPlannedAction` in an explicit `db.q.transaction()` to match PLAN wording | M12 |
| 7 | `src/mover/quarantine.ts:194-221` | Stranded actions when `tryRestore` fails are invisible to reconcile — surface them in audit log | M12 |
| 8 | `src/mover/quarantine.ts:65` | Doc/code mismatch on `uniqueDest` — re-check before rename or update comment | M11 |
| 9 | `src/classifier/rules.ts:98-105` | Empty-dir cruft sweep ignores preset whitelist | M12 |
| 10 | `src/mover/quarantine.ts:232-249` | Empty-dir removal isn't bottom-up — sort by depth descending | ✅ M11 |
| 11 | `src/classifier/cruft.ts:60` | `path_prefix` is unanchored against partial dir names — enforce trailing `/` in the schema | M12 |
| 12 | `src/main.ts:42` | `boot()` leaks a DB handle in `noServe` mode | M9 |
| 13 | `src/hasher/pool.ts:74-86` | Hashing isn't on a worker thread despite the API shape | M12 |
| 14 | `src/scanner/walker.ts` | fast-glob's `suppressErrors:true` swallows per-dir errors | M12 |
| 16 | `src/mover/purge.ts:128` | UTC parsing is fragile (`+ 'Z'` on a space-separated SQLite datetime) | ✅ pre-M11 (parseSqliteDatetime) |
| 17 | `src/mover/purge.ts:74` | Use `fs.realpathSync` to defend against symlinks inside trash | ✅ M11 |
| 18 | `src/db/index.ts:18-21` | Document that `db.q` is canonical; `db.client` is escape hatch | ✅ M11 |
| 20 | `src/db/queries.ts` | One-second `executed_at` precision; switch to `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` | ✅ M11 |
| 21 | `src/orchestrator/runStore.ts` | Scan results held only in memory — lost on server restart; persist to DB or JSON sidecar | M12 |
| 22 | `src/db/queries.ts:458` | `listAllActions` capped at 1000 rows with no pagination; `/audit` silently truncates | ✅ M10 — replaced with `listAuditPage` (filters + offset/limit) |
| 23 | `src/server/routes/*.ts` | Missing response schemas on ~8 routes; internal DB column names could leak, no OpenAPI generation | M8 |
| 24 | `src/server/routes/scans.ts:77` | `POST /quarantine/run` registered in `scans.ts` — move to `quarantine.ts` | M8 |
| 25 | `src/mover/quarantine.ts:143` | Cruft files with null hashes skip re-verification entirely (TOCTOU risk) — document as known limitation | M12 |
| 26 | `src/scanner/index.ts:72` | `discoverCollections` skips dot-prefixed directories unconditionally — undocumented | M9 |
| 27 | `src/classifier/nameCollision.ts:36-48` | O(n²) per basename group — cap or warn for large groups | M12 |
| 28 | `src/server/index.ts` | No CORS config — needed when Vite dev server lands on a different port | M8 |
| 29 | `src/mover/quarantine.ts` | No in-process mutex for destructive operations; concurrent requests could race | ✅ M11 |
| 30 | `tests/` | Missing tests: `isPathWithin` guard in quarantine, empty-dir fence, `uniqueDest` overflow (10k collisions) | ✅ M11 |

---

## Testing strategy (CI/gating spec)

Reference for what runs where and what gates a release.

| Layer | Tool | Speed | When run | Gates release? |
|---|---|---|---|---|
| Unit | vitest | ms each | every PR, all 3 OSes | yes |
| Integration | vitest + real fs/SQLite | s each | every PR, all 3 OSes | yes |
| API contract | vitest + Fastify `.inject()` | s each | every PR, all 3 OSes | yes |
| Property | vitest + fast-check | seconds total at numRuns=50 | every PR, all 3 OSes | yes |
| UI component (M9+) | vitest + Testing Library | ms each | every PR, Linux only | yes |
| UI E2E (M12) | Playwright, single targeted test | seconds | every PR, Linux only | yes |
| Manual verification | human + sandbox `target_root` | minutes | before each release on real data | yes (release blocker) |

The safety invariant — *every primary-collection byte-content present before any scan + classify + quarantine sequence is still reachable afterwards* — is the property test in `tests/integration/safetyInvariant.test.ts`. CI failure on this test must block the merge unconditionally.

## Phase 2 (out of scope for v1)

Captured here so v1 schema/architecture choices don't block them. Not to be implemented until v1 has been running on real data for at least one full retention cycle (30 days) without restoration regrets.

- **Side-quarantine for review-queue decisions.** Wire `quarantined_a` / `quarantined_b` through the mover so the review-queue rejection in M6 can be lifted.
- **Scheduled scans.** OS-native: Windows Task Scheduler (`scripts/register-task.ps1`), Linux systemd timer / cron, macOS `launchd`. Quarantine still gated behind UI approval.
- **Per-reason retention.** `cruft_*` reasons purge after 14 days; `duplicate_*` after 30. Schema already captures `reason`.
- **Perceptual-hash review for re-encoded photos.** `pHash` for jpg/png/mp4 thumbnails; surfaces visually-identical-but-byte-different photos as review candidates. Never auto-acts.
- **More built-in presets.** iOS backup, generic photo library, Time Machine, generic document collection.
- **Drag-to-reorder UI for path priority.** Replaces JSON-only config. The Settings page in M9 ships with a JSON textarea; this lifts it to a sortable list.
- **Bulk actions in the review queue.** "Keep both for all in this folder", "prefer primary collection for all from this run".
- **Multi-target_root.** Manage several `target_root`s from one UI, switch between them.
- **Organization features.** Date-folder restructuring, flattening, album generation. Each move is a quarantine + new-location pair recorded as a single transaction.
- **Packaged single-`.exe` / single binary** via `@yao-pkg/pkg` (or per-platform installers).
- **Background service / system tray.** OS-native services. Only after the core is fully trusted.
- **i18n.** Currently English-only.

## Out of scope (won't ever ship)

- Direct deletion (without quarantine). The model is rename-based by design.
- Hash-based dedup across drives without a `target_root` boundary. Too easy to cross safety boundaries unintentionally.
- Phone-side operations (ADB, Smart Switch integration). This tool is purely about bytes already on disk.

## Known v1 limitations (documented, not blocking)

- Quarantine inside `target_root` — doesn't free space until purge. Adequate given typical headroom; document.
- Single 30-day retention for all reasons.
- Filename-collision review queue may be large; v1 ships pagination + per-item only.
- No content-rename detection across scans (manually moving a file = re-hash on next scan).
- DB and audit log inside `<target_root>` — drive failure takes both. User pairs with offsite backup separately.
- First scan ≈ 15–25 minutes wall clock on the user's 155 GB Samsung dataset; re-scans ≈ <1 minute.
- Defender real-time scan can roughly double IO on Windows; document the option to exclude `<target_root>` during scans with informed consent.

## Critical files (where safety lives or dies)

Review carefully on every change:

- `src/mover/quarantine.ts`
- `src/mover/reconcile.ts`
- `src/classifier/rules.ts`
- `src/db/migrations/0000_initial.sql` (regenerated by `drizzle-kit generate` from `src/db/schema.ts`)
- `src/target/guard.ts`
- `tests/integration/safetyInvariant.test.ts`
- `tests/integration/crashRecovery.test.ts`
