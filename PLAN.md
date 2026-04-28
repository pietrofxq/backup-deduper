# Plan — safe-dedupe (working name)

A safety-first deduplication tool for collections of files in a single directory tree. Initial use case: Samsung phone backups on `E:\`. Designed to be general-purpose — any folder containing one or more "collection" subfolders that share content can be deduplicated with the same engine.

## Context

The user has two Samsung phone backups on `E:\` (`Backup s22` ≈ 77 GB / 35,258 files; `Backup s24 (27-02-2024)` ≈ 77 GB / 19,184 files; volume serial `1C04A189`, NTFS). Combined ≈ 155 GB with substantial overlap, plus 19 GB of `.exo` Exoplayer cache and 424 empty folders in s22. **Safety against accidental data loss is the dominant requirement** — the user explicitly named it as the bar.

The tool is generalized so it can later run against any directory tree (other backups, photo archives, document collections) on any OS where Node 20 runs. The Samsung phone backup is the first real-world workload but not the only intended one.

## Core abstractions

- **`target_root`** — the directory the app is pointed at. Everything happens within it. State lives at `<target_root>/.dedupe/`; quarantine at `<target_root>/.dedupe-trash/`.
- **`collection`** — a subfolder under `target_root` that the user wants to treat as a unit (e.g. `Backup s22/`, `Backup s24 (27-02-2024)/`). Multiple collections under one `target_root` get cross-deduped.
- **Primary collection** — the user manually marks one collection as primary. Files in the primary are protected from cross-collection quarantine. Within-collection dedup still applies.
- **Preset** — a named bundle of cruft rules + path-priority list (e.g. "Samsung Android phone backup"). User picks one per `target_root`, or "None" for conservative-defaults-only.

## Confirmed design decisions

| Decision | Choice |
|---|---|
| Stack | Node 20 LTS + TypeScript (`strict`); local web UI (Fastify + React/Vite); no Electron. Cross-platform: Linux/macOS/Windows. Runtime tuned for Windows (where the user's data lives). |
| App layout | Code lives wherever the developer puts it (run via `npm start`); state DB + audit log + quarantine are inside `<target_root>` so they travel with the data. |
| Match for auto-quarantine | SHA-256 byte-identical only |
| Match for review queue (never auto-acts) | Same basename, different bytes, **cross-collection only** |
| Primary collection | Manually marked via UI, sticky, persisted in DB; only one row marked primary at a time |
| Within-collection dedup | Path-priority canonical keeper. Default for "Samsung Android phone backup" preset: `DCIM/Camera > DCIM/Screenshots > DCIM/Restored > DCIM/Shared > DCIM/Snapchat > everywhere else`. Configurable per-preset. |
| Auto-quarantine cruft | Always-on (no preset needed): empty folders, OS metadata files (`Thumbs.db`, `desktop.ini`, `.DS_Store`, `ehthumbs.db`). Preset-driven additions for Samsung Android: `*.exo`, `Android/data/`, `Android/obb/`. **`Android/media/` is explicitly NOT cruft** in the Samsung preset — it holds WhatsApp photos. |
| Deletion model | Move (rename) to `<target_root>/.dedupe-trash/<run-id>/<collection>/<original-relative-path>`; auto-purge after 30 days; restore = rename back. |
| First-run safety | Dry-run is ON by default for the first scan. Disabling it requires the user to type `I have reviewed the dry-run report`. Persisted gate. |
| Target identity | A sentinel UUID file at `<target_root>/.dedupe/target-id.txt` is created on first setup. The DB stores the same UUID. On every start, the live UUID must match the bound one — otherwise refuse. Replaces the Windows-only volume-serial gate; works identically across OSes; survives drive remounts and remaps because the sentinel travels with the data. |
| Scan cadence (v1) | Manual only — "Scan now" button. Scheduling is Phase 2. |
| Organization features | Phase 2. v1 = dedup + cruft + reporting + restore only. |
| Reporting | HTML dashboard for review queue / audit log / quarantine; `audit.jsonl` on disk for grep/jq. |

## Safety invariants

These are the properties the implementation must preserve. The integration test suite operationalizes them.

1. **No direct deletions in v1.** Every "removal" is a rename inside the same volume. The `purge` subsystem (which actually deletes from the trash after retention) is a separate, gated module not invoked by normal scans.
2. **Two-phase commit for every move.** A `quarantine_action` row is inserted inside a SQLite transaction *before* `fs.renameSync`; `executed_at` is set *after* a post-move existence + size check. A killed process between the two is recoverable.
3. **Re-verify under fresh hash before quarantine.** The classifier's hash is not trusted across the classify→move gap; the mover re-stats and re-hashes.
4. **Target-sentinel gate.** The DB binds to a UUID stored at `<target_root>/.dedupe/target-id.txt`. On startup the live UUID must match, or the app refuses to start.
5. **Sanity guard.** Refuses to execute a quarantine pass that would touch >50% of files or >70% of bytes of the primary collection, unless explicitly overridden.
6. **Restore never overwrites.** If the original path is occupied by something different, the restore goes to a sidecar with `(restored)` suffix.
7. **Preset-defined "do not touch" lists.** The Samsung preset whitelists `Android/media/` (WhatsApp media etc.). Presets must enumerate path patterns that are explicitly NOT cruft, not just rely on omission.
8. **Same-volume rename only.** The mover asserts source and destination roots match (`path.parse(src).root === path.parse(dest).root`) before every rename.

The headline test: for any sequence of scan + classify + quarantine ops (no purge), every byte-content present in the primary collection before the run is still reachable somewhere afterwards — original location, another copy at the same hash in the primary, or in the quarantine with a `quarantine_action` row pointing back. Implemented as a `fast-check` property test in `tests/integration/safetyInvariant.test.ts`.

## Architecture

Single Node process. Fastify serves the React SPA + a REST/SSE API. One `worker_threads` worker for hashing (CPU work off the event loop). Mover runs sequentially on the main thread (parallel renames within one volume buy nothing and complicate failure recovery). `better-sqlite3` is synchronous — feature, not bug — so transactions compose naturally with the mover loop.

```
React SPA  ──HTTP+SSE──▶  Fastify  ──▶  Orchestrator (one job at a time: scan|quarantine|purge|restore)
                                             │
            ┌────────────────────────────────┼────────────────────────────────┐
       Scanner (main)                Hasher worker                       Mover (main)
       fs.opendir async iterator    streaming sha256                     two-phase commit
            │                              │                                  │
            └─────────────▶  better-sqlite3 (<target_root>/.dedupe/state.db)  ◀─┘
                                       │
                              audit.jsonl (append-only)
```

## SQLite schema (`<target_root>/.dedupe/state.db`)

Renamed from earlier draft to remove backup/volume framing.

- **`target`** (singleton, id=1): `target_id_uuid`, `target_root_abs` (last seen), `os_platform` ('win32' | 'linux' | 'darwin'), `bound_at`. Drive-identity gate.
- **`preset`**: `name`, `cruft_rules_json`, `path_priority_json`. Built-in rows seeded on first run; user can add rows.
- **`collection`**: one row per top-level collection under target_root; UNIQUE `rel_path`; partial unique index on `is_primary` enforces "at most one primary".
- **`file`**: one row per live file; UNIQUE (`collection_id`, `rel_path`); columns `size`, `mtime_ms`, `sha256_hex` (nullable until hashed), `last_seen_run`. Hash cache key = (size, mtime_ms) per (collection_id, rel_path). Files not seen in `last_seen_run` of the current run are deleted at end-of-scan.
- **`run`**: `kind` ∈ {scan, quarantine, purge, restore}, `status`, `dry_run`, `config_json` snapshot.
- **`quarantine_action`**: the audit-log core. `planned_at` always set; `executed_at` set after successful rename + post-move verify; `restored_at` and `purged_at` for state transitions; `reason` enum for {duplicate_cross_collection, duplicate_within_collection, cruft_empty_folder, cruft_os_metadata, cruft_preset_<rule_id>}.
- **`review_item`**: same-filename-different-bytes pairs; status ∈ {open, kept_both, quarantined_a, quarantined_b}.
- **`config`**: KV for retention days, dry-run flag, active preset id, sanity-guard thresholds.

All paths in `file` are `(collection_id, rel_path)` with no drive letter or absolute prefix — drive remaps and mountpoint changes are non-destructive to the cache.

## Classifier rule precedence

```
1. CRUFT (path-pattern match; STOP on match):
   1a. always-on: empty folders, basename ∈ {Thumbs.db, desktop.ini, .DS_Store, ehthumbs.db}
   1b. preset rules (in preset's declared order)
   1c. preset whitelist (path patterns explicitly NOT cruft) — checked FIRST against rules
       For "Samsung Android phone backup": Android/media/ is whitelisted.

2. DUPLICATE (group-by sha256_hex; STOP for whole group):
   2a. Within each collection, pick canonical via path priority; non-keepers → duplicate_within_collection
   2b. Across collections: primary's representative wins; others → duplicate_cross_collection
       If primary has no representative, lex-first collection wins (deterministic).

3. NAME COLLISION (basename group, cross-collection, hashes differ):
   → REVIEW_NAME_COLLISION; emit pairs; never auto-acts.

4. KEEP (default).
```

Cruft takes precedence over duplicate so the audit log records the *most informative* reason (a `.exo` file that's also a duplicate is logged as `cruft_preset_exo`, not `duplicate_cross_collection`).

## Module layout

```
safe-dedupe/
├─ src/
│  ├─ main.ts                   bootstrap → reconcile → serve
│  ├─ config/{schema,defaults,loader}.ts
│  ├─ db/{index,migrate,queries}.ts + db/migrations/*.sql
│  ├─ target/{sentinel,guard}.ts        UUID file create/read; refuse-to-run gate
│  ├─ presets/
│  │  ├─ types.ts                       Preset schema (zod)
│  │  ├─ samsung-android.ts             ships built-in
│  │  ├─ minimal.ts                     ships built-in (always-on rules only)
│  │  └─ index.ts                       loader + registry
│  ├─ paths/{platform,winLong,relpath}.ts  long-path on win32 only; rel-path normalization (forward slashes in DB)
│  ├─ scanner/{walker,stat,index}.ts    fs.opendir async iterator; safeStat
│  ├─ hasher/{worker,pool,sha256}.ts    one worker_threads worker; streaming SHA-256
│  ├─ classifier/{cruft,dedup,nameCollision,rules,index}.ts
│  ├─ mover/{quarantine,restore,purge,reconcile,uniqueDest}.ts
│  ├─ orchestrator/{runs,scanJob,sanityGuard,events}.ts
│  ├─ audit/{log,schema}.ts             JSONL append-only at <target_root>/.dedupe/audit.jsonl
│  ├─ server/{index,static}.ts + server/routes/{health,config,scans,review,quarantine,events}.ts
│  └─ web/                              React + Vite + TanStack Query/Table + Tailwind
└─ tests/
   ├─ unit/{classifier,paths,cache,targetGuard,presets}.test.ts
   ├─ integration/{happyPath,crashRecovery,restore,longPath,lockedFile,safetyInvariant}.test.ts
   ├─ contract/api.test.ts            boot Fastify in-process; hit REST endpoints
   └─ fixtures/syntheticTree.ts       cross-platform builders
```

The five files where safety lives or dies:

- `src/mover/quarantine.ts` — the two-phase commit move flow.
- `src/classifier/rules.ts` — precedence engine; a bug here mis-classifies real photos as cruft.
- `src/db/migrations/001_initial.sql` — schema; expensive to migrate later.
- `src/target/guard.ts` — sentinel-UUID gate.
- `tests/integration/safetyInvariant.test.ts` — operationalizes the headline invariant.

## Library picks

- **Runtime**: Node 20 LTS, TypeScript 5 (`strict`, `noUncheckedIndexedAccess`).
- **DB**: `better-sqlite3` (sync, real transactions, WAL). Native binding compiles cross-platform.
- **Server**: `fastify` 5 + `zod` 4 (schema-first validation; types shared with frontend).
- **Hashing**: built-in `crypto.createHash('sha256')` over `fs.createReadStream` (1 MB highWaterMark). No third-party hash lib.
- **Walker**: native `fs.opendir` async iterator, hand-rolled recursion (~80 LOC). Explicit symlink rejection, depth tracking, per-dir error handling. **No `fast-glob`/`globby`/`fs-extra`.**
- **UUID**: built-in `crypto.randomUUID()`.
- **Logging**: `pino` (Fastify-native; structured JSON to stdout + `<target_root>/.dedupe/app.log`).
- **Frontend**: React 19 + Vite 6 + Tailwind 4 + TanStack Query 5 + TanStack Table 8. Built bundle served by Fastify at `/`.
- **Tests**: `vitest` 2 + `fast-check` 3 (property-based for the safety invariant).
- **API contract tests**: Fastify's `.inject()` for in-process request testing — no HTTP socket needed, no Playwright, no extra deps.

Removed since the cross-platform pivot:
- `execa` PowerShell call for volume serial — replaced by reading the sentinel UUID file (built-in `fs`).

Not used: Electron, Drizzle/Prisma, chokidar, fs-extra, third-party glob libs, WebSockets.

## Runtime layout under `<target_root>`

```
<target_root>/                       e.g. E:\ on Windows, /mnt/photos on Linux
├─ Backup s22/                       collection (user data, untouched except by quarantine moves)
├─ Backup s24 (27-02-2024)/          collection; currently marked is_primary
├─ .dedupe/                          hidden (attrib +H on Windows; dot-prefix on POSIX); created on first run
│  ├─ target-id.txt                  the sentinel UUID; bound to the DB
│  ├─ state.db / state.db-wal / state.db-shm
│  ├─ state.db.backup-YYYY-MM-DD     weekly snapshot, keep last 4
│  ├─ audit.jsonl                    append-only
│  ├─ app.log
│  └─ config.json
└─ .dedupe-trash/                    hidden
   └─ <ISO-timestamp>-run-<id>/
      └─ <collection-name>/<original-relative-path>/<file>
```

## Testing strategy

Five layers, in priority order. The first four run in CI on Linux + macOS + Windows runners; the last is the human-in-the-loop step before pointing at real data.

### 1. Unit (~ms each, hundreds of cases)

Pure logic, no I/O.

- **Classifier rule precedence.** Table-driven: input set of `{rel_path, hash, collection_id}` tuples → expected `Decision[]`. Cover every rule + boundary (cruft-and-duplicate priority, primary-wins-cross-collection, path priority, deterministic tiebreak). Critical: `Android/media/` whitelist asserted explicitly.
- **Path utilities.** `\\?\` prefix on Windows-only; rel-path normalization (always-forward-slashes in DB; OS-native at fs boundary); root-escape guard (a `..`-bearing relative path can't escape the collection).
- **Cache invalidation.** (size, mtime_ms) unchanged → reuse hash; either changed → re-hash queue; row not seen → delete.
- **Sanity-guard math.** 50% / 70% threshold logic; off-by-one boundary tests.
- **Target-sentinel.** Generate UUID; persist; reload; refuse mismatch; refuse missing.
- **Presets.** Each built-in preset round-trips through zod schema; whitelist correctly excludes from rule matching.

### 2. Integration — filesystem + DB (~seconds each, tens of cases)

Real OS temp directory, real SQLite. Each test:

1. Builds a synthetic tree under `os.tmpdir()` (cross-platform fixtures).
2. Initializes the tool against it (`target_root = <tmpdir>`).
3. Runs scan + classify + quarantine.
4. Asserts both disk state AND DB state.

Cases to cover:

- **Happy-path cross-collection dedup.** Two collections, identical photo in both, primary=B → A's copy quarantined, B's untouched, one `quarantine_action` row with `executed_at` set.
- **Within-collection dedup with path priority.** Same hash at `DCIM/Camera/x.jpg` and `Download/x.jpg` → Download's copy quarantined.
- **Cruft inside `Android/data/`.** → quarantined as `cruft_preset_android_data`.
- **`Android/media/` survives.** Even when otherwise byte-duplicate of an `Android/data/` file → preset whitelist wins, kept.
- **Filename-collision review.** Two `IMG_0001.jpg` files, different bytes, in different collections → `review_item` row, no quarantine.
- **Restore.** Quarantine, then restore; `Get-FileHash`-equivalent matches the recorded `sha256_hex`.
- **Restore with conflict.** Quarantine, then place a different file at the source path, attempt restore → refusal + sidecar `(restored)` option triggered.
- **Crash recovery.** Inject `process.exit(1)` between INSERT planned action and rename. Restart → reconciliation moves to executed. Verify with both source-still-present and source-already-moved scenarios.
- **Locked file.** Open exclusive handle on a file; quarantine it; expect retry-then-error, file untouched. (Run only on Windows; POSIX rename doesn't fail on open files.)
- **Long path / deep nesting.** Generate 150-deep tree; walk + hash + rename succeeds. (Windows-specific; the long-path helper is exercised here.)
- **Mountpoint change simulation.** Boot tool against a tmp dir; move the tmp dir to a sibling location; restart → tool detects via sentinel UUID and prompts for new `target_root_abs`. Verify cache survives.
- **Dry-run does nothing.** No `executed_at` set, no fs changes, only a JSON report on disk.
- **Sanity-guard trips.** Build a pathological tree where >50% of primary would be quarantined; expect hard stop unless override flag set.

### 3. API contract (~seconds each, tens of cases)

Boot Fastify in-process via `.inject()` — no socket, no Playwright. Hit each REST route and assert response shape (zod-validated) + DB side-effects. The orchestrator boundary is exercised without UI noise.

- `POST /scans` starts a job, returns `run_id`, persists `run` row.
- `GET /scans/:id` returns status; SSE feed emits hashed-progress events during a long-running test.
- `POST /quarantine/restore/:id` invokes the restore mover; happy path + conflict path.
- `GET /review`, `POST /review/:id/decision` round-trip a review-queue decision.
- `PUT /config` validates against zod schema; refuses bad inputs (e.g. retention_days < 1).

### 4. Property — `fast-check` (the big one)

The safety invariant test:

```typescript
test('safety: no primary-collection content can be lost', () => {
  fc.assert(fc.property(arbitraryCollectionTree(), (tree) => {
    const before = hashAllFilesUnder(tree.primaryCollectionRoot);
    runScanAndQuarantine(tree.targetRoot);  // no purge
    const after = hashAllFilesAndQuarantineUnder(tree.targetRoot);
    for (const hash of before.values()) {
      expect(after.has(hash)).toBe(true);  // every original byte-content still recoverable
    }
  }), { numRuns: 50 });
});
```

The `arbitraryCollectionTree()` generator covers degenerate cases (single file, all-duplicates, all-cruft, deeply nested, random preset selections). 50 cases in CI; `npm run test:thorough` runs 500.

### 5. Manual verification on real data

The de-facto E2E. Codified in the README's first-run protocol:

1. User copies real data to `<target_root>/test-collection/`.
2. Tool's `target_root` is set to that copy.
3. Run dry-run; spot-check 20 random rows per `reason` against actual files.
4. Disable dry-run via the type-to-confirm gate. Re-run.
5. Verify quarantine structure mirrors original paths; restore 5 random files; confirm hashes match.
6. Trigger conflict-restore manually.
7. Only then change `target_root` to the real location and start with a dry-run again.

### What we deliberately don't test

- **Full browser E2E (Playwright/Cypress).** Skipped for v1. The safety-critical logic — mover, classifier, SQL transactions — is 100% testable through layers 1–4 with no UI involved. UI bugs that would affect data safety are vanishingly rare; UI bugs that affect UX are caught by the user immediately. If a specific UI flow becomes high-stakes (e.g. the type-to-confirm dialog), add a single targeted Playwright test for that flow only.
- **Performance benchmarks beyond a smoke threshold.** Phase 2 once the safety story is proven.
- **Mocking the filesystem.** All filesystem tests use real tmp dirs. Mocking `fs` hides exactly the kind of platform-specific behavior we need to verify (atomic rename semantics, lock errors, long paths).

### CI gating

- Layers 1–4 must pass on Linux, macOS, and Windows runners.
- Zero new `quarantine_action` rows in any test ever cause a hash that existed in the primary before the test to be unreachable after the test (asserted via the property test).
- Test wall-clock budget: <5 min for unit + integration + contract; <2 min for property at numRuns=50. Total CI time per OS ≤ 10 min.

## Implementation order (milestones)

See `ROADMAP.md`.

## Verification before pointing at real data

See README "Verification" section.

## Known v1 limitations

- Quarantine on the same volume — doesn't free space until purge. Document it.
- Single 30-day retention for all reasons. Schema captures `reason` so per-reason retention can be added later without migration.
- Filename-collision review queue may be large; v1 ships pagination + per-item only.
- No content-rename detection across scans (manually moving a file = re-hash on next scan).
- DB and audit log live inside `<target_root>` — drive failure takes both. Pair with offsite backup separately.
- First scan ≈ 15–25 min wall clock on the 155 GB Samsung dataset; re-scans ≈ <1 min.
- Defender real-time scan can roughly double IO on Windows; document the option to exclude `<target_root>` during scans.

## Critical files for implementation

- `src/mover/quarantine.ts`
- `src/classifier/rules.ts`
- `src/db/migrations/001_initial.sql`
- `src/target/guard.ts`
- `tests/integration/safetyInvariant.test.ts`
