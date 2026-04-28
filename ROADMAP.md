# Roadmap

Derived from [PLAN.md](./PLAN.md). Milestones are sequential — each builds on the previous one's invariants. Don't skip ahead.

The codebase is cross-platform (develop on Linux/macOS/Windows). Runtime targets all three but is tuned for Windows since that's where the user's primary data lives.

## v1 milestones

### M1. Skeleton + DB + target-sentinel guard
- `package.json`, `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`), `vitest.config.ts`.
- `src/main.ts` boots; `src/db/migrate.ts` applies `001_initial.sql`.
- `src/target/sentinel.ts` reads/creates `<target_root>/.dedupe/target-id.txt` (built-in `crypto.randomUUID()`); no shell calls.
- `src/target/guard.ts` refuses to start if the live UUID doesn't match `target.target_id_uuid` in the DB; logs the absolute path discrepancy when one occurs.
- `src/paths/platform.ts` detects OS once at startup; `winLong.ts` no-ops on POSIX.
- **Smoke:** app boots against an empty tmp dir, generates the sentinel + DB, refuses on a wrong-UUID mock.
- **Tests added:** unit — `targetGuard.test.ts`, `paths.test.ts` (Windows-only branches gated by `process.platform === 'win32'`).

### M2. Scanner + hasher + cache
- `src/scanner/walker.ts` — hand-rolled `fs.opendir` async iterator with explicit symlink rejection, depth tracking (warn at >100), per-dir error handling.
- `src/scanner/stat.ts` — `safeStat` returning `null` on `ENOENT`.
- `src/hasher/worker.ts` — `worker_threads` worker streaming SHA-256 over `fs.createReadStream` (1 MB highWaterMark).
- `src/hasher/pool.ts` — single-worker queue with backpressure.
- `src/scanner/index.ts` — orchestrates walk → upserts `file` rows; cache key = (size, mtime_ms) per (collection_id, rel_path); files not seen in `last_seen_run` are deleted post-walk.
- **Smoke:** first scan of a tmp tree completes; second scan completes in ms (stat-only path for unchanged files).
- **Tests added:** unit — `cache.test.ts` (stat-unchanged → reuse, stat-changed → re-hash, file-disappeared → row deleted); integration — first-scan + re-scan happy path on a synthetic 1k-file tree.

### M3. Presets + classifier + dry-run reporting
- `src/presets/types.ts` (zod schema), `samsung-android.ts`, `minimal.ts`, `index.ts`.
- `src/classifier/cruft.ts` — preset-driven path-pattern rules; whitelist checked first. Critical assertion: `Android/media/` whitelist beats every cruft rule in the Samsung preset.
- `src/classifier/dedup.ts` — group by `sha256_hex`; within-collection canonical keeper via path priority; cross-collection primary-wins; deterministic lex tiebreak.
- `src/classifier/nameCollision.ts` — basename grouping cross-collection, hashes differ, emit pairs.
- `src/classifier/rules.ts` — top-level precedence: cruft → duplicate → name-collision → keep.
- Dry-run produces `<target_root>/.dedupe/reports/<run-id>.json` listing every planned action with reason + counts + bytes.
- No fs writes other than the report.
- **Tests added:** unit — `classifier.test.ts` (table-driven, every rule + boundary), `presets.test.ts` (each preset round-trips zod, whitelist behavior); integration — full dry-run on a synthetic tree with the Samsung preset, snapshot-tested against an expected report.

### M4. Mover (quarantine) + reconcile + sanity guard + dry-run gate
- `src/mover/quarantine.ts` — two-phase commit: pre-flight stat → re-hash → INSERT planned row → `mkdir -p` dest parent → `fs.renameSync` → post-move verify → set `executed_at` + `verified_at` → DELETE file row.
- `src/mover/uniqueDest.ts` — collision suffix `(1)`, `(2)`...
- `src/mover/reconcile.ts` — startup: mark stale `running` runs as `crashed`; for each `executed_at IS NULL AND error IS NULL` action, retry or mark error.
- `src/orchestrator/sanityGuard.ts` — abort if planned actions exceed 50% files or 70% bytes of the primary collection, unless explicitly overridden.
- Type-to-confirm gate ("I have reviewed the dry-run report") to disable dry-run for the first time. Persisted in `config` table.
- **Tests added:** integration — `crashRecovery.test.ts` (kill mid-move, restart, verify reconcile), `lockedFile.test.ts` (Windows-only), `longPath.test.ts` (Windows-only, 150-deep), `restore.test.ts` (happy + conflict). Property — first pass of `safetyInvariant.test.ts` at `numRuns: 50`.

### M5. Restore + purge
- `src/mover/restore.ts` — verify quarantine file still matches recorded hash → reconstruct current path from `(target.target_root_abs, collection, rel_path)` → refuse if target occupied with different content (offer `(restored)` sidecar) → rename back → re-upsert `file` row.
- `src/mover/purge.ts` — separate runner; deletes from `.dedupe-trash/` only entries with `executed_at + 30 days < now`. Never invoked by scans. Time-gated.
- Bulk-restore by `run_id`.
- **Tests added:** integration — bulk restore, purge dry-run on synthetic 30-day-old action, purge refusal on too-young actions.

### M6. Web UI + API contract tests
- `src/server/index.ts` — Fastify boot, register routes, serve `web/dist/` static at `/`.
- Routes: `/health`, `/config`, `/collections` (list + mark primary), `/presets`, `/scans`, `/review`, `/quarantine`, `/events` (SSE).
- `web/` — React SPA. Pages:
  - **Dashboard** — primary collection, last run summary, scan-now button, dry-run banner.
  - **ReviewQueue** — paginated table of name-collision pairs; per-item decisions.
  - **AuditLog** — `quarantine_action` browser, filter by reason / run / date.
  - **Quarantine** — files currently in `.dedupe-trash/`, restore button.
  - **Settings** — set primary, pick preset, edit retention days, dry-run toggle (with confirmation phrase).
- SSE-driven progress bar during scans.
- **Tests added:** API contract — `tests/contract/api.test.ts` using Fastify `.inject()`. Covers every route shape (zod-validated requests + responses) and DB side-effects without HTTP sockets or browsers.

### M7. CI matrix + ship
- GitHub Actions matrix: `{ubuntu-latest, macos-latest, windows-latest}` × Node 20.
- All five test layers green: unit + integration + contract + property + lint/typecheck.
- Property test at `numRuns: 50` in CI; `npm run test:thorough` for `numRuns: 500` ad-hoc.
- Manual verification protocol from README executed against `<target_root>/test-collection/`.
- Then and only then: switch `target_root` to the real `E:\` and run a dry-run on real data.

## Testing strategy (CI/gating spec)

Reference for what runs where and what gates a release.

| Layer | Tool | Speed | When run | Gates release? |
|---|---|---|---|---|
| Unit | vitest | ms each | every PR, all 3 OSes | yes |
| Integration | vitest + real fs/SQLite | s each | every PR, all 3 OSes | yes |
| API contract | vitest + Fastify `.inject()` | s each | every PR, all 3 OSes | yes |
| Property | vitest + fast-check | seconds total at numRuns=50 | every PR, all 3 OSes | yes |
| Manual verification | human + sandbox `target_root` | minutes | before each release on real data | yes (release blocker) |
| Browser E2E | — | — | not run | no — explicitly out of scope for v1 |

The safety invariant — *every primary-collection byte-content present before any scan + classify + quarantine sequence is still reachable afterwards* — is the property test in `tests/integration/safetyInvariant.test.ts`. CI failure on this test must block the merge unconditionally.

## Phase 2 (out of scope for v1)

Captured here so v1 schema/architecture choices don't block them. Not to be implemented until v1 has been running on real data for at least one full retention cycle (30 days) without restoration regrets.

- **Scheduled scans.** OS-native: Windows Task Scheduler (`scripts/register-task.ps1`), Linux systemd timer / cron, macOS `launchd`. Quarantine still gated behind UI approval.
- **Per-reason retention.** `cruft_*` reasons purge after 14 days; `duplicate_*` after 30. Schema already captures `reason`.
- **Perceptual-hash review for re-encoded photos.** `pHash` for jpg/png/mp4 thumbnails; surfaces visually-identical-but-byte-different photos as review candidates. Never auto-acts.
- **More built-in presets.** iOS backup, generic photo library, Time Machine, generic document collection.
- **Drag-to-reorder UI for path priority.** Replaces JSON-only config in M3.
- **Bulk actions in the review queue.** "Keep both for all in this folder", "prefer primary collection for all from this run".
- **Multi-target_root.** Manage several `target_root`s from one UI, switch between them.
- **Organization features.** Date-folder restructuring, flattening, album generation. Each move is a quarantine + new-location pair recorded as a single transaction.
- **Packaged single-`.exe` / single binary** via `@yao-pkg/pkg` (or per-platform installers).
- **Background service / system tray.** OS-native services. Only after the core is fully trusted.
- **Targeted Playwright test for type-to-confirm.** Only if the UI flow gets more complex.

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
- `src/classifier/rules.ts`
- `src/db/migrations/001_initial.sql`
- `src/target/guard.ts`
- `tests/integration/safetyInvariant.test.ts`
