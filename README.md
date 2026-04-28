# safe-dedupe (working name)

A safety-first, general-purpose deduplication tool for collections of files in a directory tree. Designed initially for Samsung phone backups but works on any folder.

**Status:** Not yet implemented. Design is locked in [PLAN.md](./PLAN.md). Milestones in [ROADMAP.md](./ROADMAP.md).

## What it does

You point the tool at a `target_root` directory. Inside it, you have one or more **collections** (subfolders the tool treats as units). You mark one collection as **primary** — its files are protected from cross-collection quarantine. The tool:

- detects byte-identical duplicates and removes them from non-primary collections (canonical keeper picked by configurable path priority within each collection),
- removes obvious cruft based on a chosen **preset** (e.g. "Samsung Android phone backup": `*.exo`, `Android/data/`, `Android/obb/`, OS metadata files, empty folders), with explicit whitelists (`Android/media/` is never cruft in the Samsung preset — it holds WhatsApp media),
- surfaces same-filename-different-bytes pairs across collections for human review (never auto-acts on these),
- runs entirely on `localhost` with a small web UI you open in a browser.

The user's first workload: `Backup s22/` and `Backup s24 (27-02-2024)/` under `E:\` on Windows. Other workloads (photo-library archives, document collections, other backups) work the same way — pick a different preset, or "None" for conservative-defaults-only.

## Develop anywhere, run where the data lives

- **Code is cross-platform.** Develop on Linux, macOS, or Windows. Stack is Node 20 LTS + TypeScript + Fastify + better-sqlite3 + React/Vite — every dependency works on all three.
- **Run on the platform native to your data.** For the user's primary case (`E:\` on Windows), run on Windows so filesystem ops are native NTFS instead of going through the WSL2 ↔ /mnt/e/ 9P bridge (which is 5–20× slower for stat-heavy workloads).
- **No platform-specific shell calls in the runtime.** Earlier drafts used PowerShell for volume identification; replaced with a sentinel UUID file (see safety model). No PowerShell, no `wmic`, no `diskutil` — just `fs`.

## Safety model

1. **No file is ever deleted in v1.** "Removal" = rename into `<target_root>/.dedupe-trash/<run-id>/<collection>/<original-relative-path>/`. After 30 days a separate `purge` subsystem actually deletes from the trash. Restore = rename back.
2. **First scan is dry-run.** Produces a report; moves nothing. Disabling dry-run requires typing `I have reviewed the dry-run report`, not just clicking.
3. **Two-phase commit on every move.** A planned-action row is written to SQLite *before* `fs.rename`; `executed_at` is set *after* a post-move size + existence check. A killed process between the two is recoverable on next start.
4. **Re-verify under fresh hash before quarantine.** Classifier hash isn't trusted across the classify→move gap.
5. **Target-sentinel gate.** On first setup, the tool generates a UUID and writes it to `<target_root>/.dedupe/target-id.txt`. The DB stores the same UUID. On every start, the live UUID must match — otherwise the app refuses to run. This protects against accidentally pointing at a different folder (drive remap, mountpoint reuse, typo'd path). The sentinel travels with the data, so a drive remount or letter change is non-destructive — the tool just confirms the new path on next launch.
6. **Sanity guard.** Refuses to execute a quarantine pass that would touch >50% of files or >70% of bytes of the primary collection, unless explicitly overridden.
7. **Restore never overwrites.** If the original path is occupied, restore goes to a sidecar with `(restored)` suffix.
8. **Preset whitelists.** Each preset enumerates path patterns that are explicitly NOT cruft — checked before rule matching. Prevents an over-broad rule from sweeping user content.

The headline invariant — *for any scan + classify + quarantine sequence (no purge), every byte-content that existed in the primary collection before the run remains reachable somewhere* — is operationalized as a `fast-check` property test (`tests/integration/safetyInvariant.test.ts`) that runs on every CI build.

## Stack

- **Runtime:** Node 20 LTS + TypeScript (`strict`, `noUncheckedIndexedAccess`)
- **Storage:** `better-sqlite3` (`<target_root>/.dedupe/state.db`, WAL mode)
- **Server:** `fastify` 5 + `zod` 4
- **UI:** `react` 19 + `vite` 6 + `tailwind` 4 + `@tanstack/react-query` + `@tanstack/react-table`
- **Hashing:** built-in `crypto.createHash('sha256')` (no third-party hash lib)
- **Tests:** `vitest` 2 + `fast-check` 3, plus Fastify's `.inject()` for in-process API contract tests

Deliberately not used: Electron, Drizzle/Prisma, chokidar, fs-extra, third-party glob libraries, Playwright (see Testing strategy). Each is a vector for "did something I didn't expect" surprises in a safety-critical tool.

## Testing strategy

Five layers, in priority order. The first four run in CI on Linux + macOS + Windows; the last is the human-in-the-loop step before pointing at real data.

1. **Unit (~ms each, hundreds of cases).** Pure logic, no I/O. Classifier rule precedence (table-driven), path utilities, cache invalidation, sanity-guard math, target-sentinel handling, preset round-tripping.
2. **Integration — filesystem + SQLite (~seconds each, tens of cases).** Real OS temp directories, real `fs.rename`, real SQLite. End-to-end scan → classify → quarantine → restore against synthetic trees. The load-bearing layer for safety. Covers crash recovery, locked files, long paths, mountpoint changes, dry-run, sanity-guard trips.
3. **API contract (~seconds each, tens of cases).** Boot Fastify in-process via `.inject()` — no socket, no Playwright. Validates the orchestrator boundary without UI noise.
4. **Property (`fast-check`).** The safety invariant: for any randomized collection tree + scan + classify + quarantine sequence, every primary-collection byte-content remains reachable. 50 cases in CI; `npm run test:thorough` runs 500.
5. **Manual verification on real data.** The first-run protocol below. The de-facto E2E.

**Browser E2E (Playwright) is intentionally skipped for v1.** The safety-critical logic — mover, classifier, SQL transactions — is 100% testable through layers 1–4 with no UI involved. UI bugs that would affect data safety are vanishingly rare; UI bugs that affect UX surface immediately to a single user. If a specific UI flow becomes high-stakes (the type-to-confirm dialog is the candidate), add one targeted Playwright test for that flow.

**Mocking the filesystem is also deliberately avoided.** All filesystem tests use real tmp dirs because mocks hide the platform-specific behavior we need to verify (atomic rename semantics, lock errors, long paths on Windows).

CI matrix: Linux + macOS + Windows. Property test at `numRuns: 50` per platform. Total CI time budget: ≤ 10 min per OS.

## Layout under `<target_root>` once running

```
<target_root>/                       e.g. E:\, /mnt/photos, ~/dedupe-test
├─ Backup s22/                       collection (user data)
├─ Backup s24 (27-02-2024)/          collection; currently marked is_primary
├─ .dedupe/                          hidden; tool state, travels with the data
│  ├─ target-id.txt                  the sentinel UUID
│  ├─ state.db / state.db-wal / state.db-shm
│  ├─ state.db.backup-YYYY-MM-DD     weekly snapshot, keep last 4
│  ├─ audit.jsonl                    append-only
│  ├─ app.log
│  └─ config.json
└─ .dedupe-trash/                    hidden; quarantine
   └─ <ISO-timestamp>-run-<id>/
      └─ <collection-name>/<original-relative-path>/<file>
```

`.dedupe/` is dot-prefixed (POSIX-hidden by default). On Windows the tool also sets the hidden attribute (`attrib +H`) on first creation.

## How to run (once implemented)

Not runnable yet. Once implemented:

```
npm install
npm run build:web         # builds the React bundle Fastify will serve
TARGET_ROOT=E:\ npm start # opens http://localhost:7777
npm test                  # unit + integration + contract + property
npm run test:thorough     # property test at numRuns=500
```

First-run flow:

1. Tool starts in dry-run mode by default. Detects `target-id.txt` is missing → prompts to create the sentinel UUID.
2. UI lists collections under `target_root`; you mark one as primary (e.g. `Backup s24 (27-02-2024)`) and pick a preset (e.g. "Samsung Android phone backup").
3. Click "Scan now" → dry-run report appears.
4. Spot-check 20 random rows per `reason` against the actual files on disk.
5. Type the confirmation phrase to disable dry-run.
6. Re-scan; quarantine actions execute.

## Verification before pointing at real data

1. Make a separate physical-drive backup of any irreplaceable data (the user is doing this for `Backup s22/` + `Backup s24/`).
2. Copy the source folders to a sandbox path inside `target_root` (e.g. `<target_root>/test-collection/`).
3. Set `target_root` to the sandbox path in `<target_root>/.dedupe/config.json` or via the UI.
4. Run unit + integration + contract + property suite (`npm test`); the safety-invariant property test must pass at `numRuns: 50` minimum.
5. Run dry-run + real-mode + restore + conflict-restore against the sandbox.
6. Only then change `target_root` to the real location and run against real folders, starting again with a dry-run.

## See also

- Design & rationale: [PLAN.md](./PLAN.md)
- Milestones: [ROADMAP.md](./ROADMAP.md)
