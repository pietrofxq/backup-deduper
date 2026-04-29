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

### ⬜ M8. Web app scaffold + design system

- `web/` — Vite 6 project, React 19, TypeScript with the same `strict` + `noUncheckedIndexedAccess` flags as the server.
- `web/src/main.tsx`, `web/src/App.tsx`, router (TanStack Router or React Router — pick one and document).
- Tailwind 4 set up with a small token palette (one accent, one warning for the dry-run banner, neutral grays). Dark mode optional.
- TanStack Query 5 client + a tiny typed `apiClient.ts` that mirrors the Fastify routes (no schema duplication — share the zod schemas from `src/server/routes/*.ts` via a `web/api-types.ts` re-export, OR keep them duplicated and document why).
- Vite dev server proxies `/api/*` (we'll prefix server routes with `/api/`) to Fastify on `:7777`. Fastify continues to serve `web/dist/` at `/` in production via `@fastify/static`.
- `npm run build:web` produces a deployable bundle Fastify mounts at `/`.
- `npm run dev` runs Fastify (tsx) and Vite concurrently.
- **Server-side change:** prefix all current routes with `/api/` so the SPA owns `/`. Update contract tests + the embedded fallback.
- **Tests added:** unit — `apiClient.test.ts` (mocks fetch and asserts the inferred TypeScript types match the server's zod schemas at compile time). Vitest in `web/` runs with `jsdom`.

### ⬜ M9. Dashboard + Settings pages

- **Dashboard.** Renders: target_root, sentinel UUID, primary collection name, last scan summary (counts by reason, total bytes, sanity-guard verdict), big "Scan now" button, dry-run banner that's red until disabled.
- **Settings.** Form for: pick preset (dropdown from `/api/presets`), set retention days (number input, min 1), edit sanity-guard thresholds (sliders, both default-disabled). The dry-run toggle is its own component with the type-to-confirm dialog (M12).
- TanStack Query manages all reads with stale-while-revalidate; mutations invalidate the right keys.
- The dashboard's "Scan now" kicks off `POST /api/scans` and shows a result panel. Progress is a placeholder until SSE lands in M11.
- **Tests added:** Vitest + Testing Library — `Dashboard.test.tsx` (renders mocked health + collections + last-run; clicking Scan calls the POST), `Settings.test.tsx` (preset dropdown wires to PUT /config; retention-days validation).

### ⬜ M10. Quarantine + Audit Log + Review Queue pages

- **Quarantine.** TanStack Table over `/api/quarantine`. Columns: collection, rel-path, reason, size, planned/executed timestamps. Per-row "Restore" button (calls `POST /api/quarantine/restore`); bulk restore via row selection. "Purge eligible" button surfaces a dry-run summary first, then a second click to actually purge.
- **AuditLog.** TanStack Table over `/api/audit`. Filter by reason, run id, date range. Includes purged + restored rows so the full history is visible. Read-only.
- **ReviewQueue.** TanStack Table over `/api/review?status=open`. Each row shows the basename, the two paths + sha prefixes + sizes. Decision buttons: "Keep both" only for v1 (the API rejects `quarantined_a/b` until M13 wires the side-quarantine flow). The button shows a tooltip explaining what "Keep both" does.
- All three pages share a `useTable` hook that handles pagination, column visibility, and CSV export.
- **Tests added:** `Quarantine.test.tsx`, `AuditLog.test.tsx`, `ReviewQueue.test.tsx` (each: render with mocked data, exercise filter + sort + a primary action; assert the API mock is called correctly).

### ⬜ M11. SSE progress + locked-file / long-path test gaps

- **SSE.** New route `GET /api/events` opens a server-sent-event stream. The `runScanJob` orchestrator already emits typed `ScanJobProgressEvent` values to a callback; route them through an in-process event bus and serialize as SSE. Heartbeat every 15s; client reconnects with last event id.
- Dashboard subscribes; while a scan is running, the result panel becomes a live progress bar (files discovered → files hashed → classified → done). On `done`, refetch the run detail.
- Cancel button → `POST /api/scans/:id/cancel` (orchestrator cooperatively aborts after the next file).
- **Filling the M4 test gap.** Add `lockedFile.test.ts` (Windows-only) and `longPath.test.ts` (Windows-only, 150-deep path). Both run only when `process.platform === 'win32'` so Linux CI doesn't fake them.
- **Tests added:** `tests/contract/events.test.ts` — uses Fastify `.inject()` with a streaming body to assert the SSE wire format. Plus the two Windows-only integration tests.

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

## Suggestion backlog from the post-implementation code review

These are the non-blocking items the M7 hardening pass surfaced. Tagged with the milestone where they should ship.

| # | File | Issue | Target |
|---|---|---|---|
| 5 | `src/db/index.ts:38` | `synchronous=NORMAL` — switch to FULL for power-loss durability | M11 |
| 6 | `src/mover/quarantine.ts:170-178` | Wrap `insertPlannedAction` in an explicit `db.q.transaction()` to match PLAN wording | M11 |
| 7 | `src/mover/quarantine.ts:194-221` | Stranded actions when `tryRestore` fails are invisible to reconcile — surface them in audit log | M11 |
| 8 | `src/mover/quarantine.ts:65` | Doc/code mismatch on `uniqueDest` — re-check before rename or update comment | M11 |
| 9 | `src/classifier/rules.ts:98-105` | Empty-dir cruft sweep ignores preset whitelist | M11 |
| 10 | `src/mover/quarantine.ts:232-249` | Empty-dir removal isn't bottom-up — sort by depth descending | M11 |
| 11 | `src/classifier/cruft.ts:60` | `path_prefix` is unanchored against partial dir names — enforce trailing `/` in the schema | M11 |
| 12 | `src/main.ts:42` | `boot()` leaks a DB handle in `noServe` mode | M9 |
| 13 | `src/hasher/pool.ts:74-86` | Hashing isn't on a worker thread despite the API shape | M11 |
| 14 | `src/scanner/walker.ts` | fast-glob's `suppressErrors:true` swallows per-dir errors | M11 |
| 16 | `src/mover/purge.ts:128` | UTC parsing is fragile (`+ 'Z'` on a space-separated SQLite datetime) | M11 |
| 17 | `src/mover/purge.ts:74` | Use `fs.realpathSync` to defend against symlinks inside trash | M11 |
| 18 | `src/db/index.ts:18-21` | Document that `db.q` is canonical; `db.client` is escape hatch | M11 |
| 20 | `src/db/queries.ts` | One-second `executed_at` precision; switch to `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` | M11 |
| 21 | `src/orchestrator/runStore.ts` | Scan results held only in memory — lost on server restart; persist to DB or JSON sidecar | M9 |
| 22 | `src/db/queries.ts:458` | `listAllActions` capped at 1000 rows with no pagination; `/audit` silently truncates | M10 |
| 23 | `src/server/routes/*.ts` | Missing response schemas on ~8 routes; internal DB column names could leak, no OpenAPI generation | M8 |
| 24 | `src/server/routes/scans.ts:77` | `POST /quarantine/run` registered in `scans.ts` — move to `quarantine.ts` | M8 |
| 25 | `src/mover/quarantine.ts:143` | Cruft files with null hashes skip re-verification entirely (TOCTOU risk) — document as known limitation | M11 |
| 26 | `src/scanner/index.ts:72` | `discoverCollections` skips dot-prefixed directories unconditionally — undocumented | M9 |
| 27 | `src/classifier/nameCollision.ts:36-48` | O(n²) per basename group — cap or warn for large groups | M11 |
| 28 | `src/server/index.ts` | No CORS config — needed when Vite dev server lands on a different port | M8 |
| 29 | `src/mover/quarantine.ts` | No in-process mutex for destructive operations; concurrent requests could race | M11 |
| 30 | `tests/` | Missing tests: `isPathWithin` guard in quarantine, empty-dir fence, `uniqueDest` overflow (10k collisions) | M11 |

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
