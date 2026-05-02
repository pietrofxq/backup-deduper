# Known gaps

Things that are wrong, incomplete, or intentionally deferred but not yet
flagged in [`ROADMAP.md`](../ROADMAP.md). When you address one of these,
either close it here or update the ROADMAP backlog item it now lives under.

## Documentation drift (against current code)

| # | claim in… | reality | status |
|---|-----------|---------|--------|
| D-1 | README §Stack: "Logging: pino"; PLAN: "structured JSON to stdout + `<target_root>/.dedupe/app.log`" | `pino` is in `package.json` but **never imported** by app code. Fastify's default logger writes to stdout only. No `app.log` is ever created. | ✅ closed in this PR — README/PLAN updated to "Fastify default logger to stdout + `audit.jsonl`". `pino` dep removal pending (still pulled in transitively by Fastify; deleting the direct dep doesn't change runtime behavior). |
| D-2 | README & PLAN: `state.db.backup-YYYY-MM-DD weekly snapshot, keep last 4` | **Not implemented.** No code creates DB backup files. | ✅ closed in this PR — claim removed from README and PLAN. The snapshot job is not on the roadmap; if/when it ships, re-add the line. |
| D-3 | README §Layout / PLAN §Runtime layout: `<target_root>/.dedupe/config.json` | Config is in the SQLite `config` table, not a JSON file. | ✅ closed in this PR — removed from both layout diagrams; first-run protocol no longer references it. |
| D-4 | PLAN §Critical files: `src/db/migrations/001_initial.sql` | Drizzle generated `0000_initial.sql`. | ✅ closed in this PR. |
| D-5 | README §How to run: "Once implemented: …" plus "Not yet implemented" header at top of README | Most of v1 (M1–M11) **is** implemented. | ✅ closed in this PR — status line and "How to run" section rewritten to reflect M11-shipped reality. |
| D-6 | README §Layout claims an "embedded HTML/JS file at `src/server/static.ts` is served as a fallback" | Implicit in earlier README; the new layout diagram no longer mentions the fallback. M13 will remove the embedded HTML entirely. | ✅ phrasing closed in this PR; code-side removal stays in M13. |
| D-7 | AGENTS.md "five files where safety lives or dies" lists nine files; not five | Cosmetic — the count grew over time. | ✅ closed in this PR — section retitled "The files where safety lives or dies"; PLAN's authoritative list updated to match. |

## Real bugs / risky holes not in ROADMAP backlog

These are not currently tracked. Each should be triaged and either fixed
or moved into the ROADMAP backlog table.

| # | location | issue |
|---|----------|-------|
| ~~SG-1~~ | ~~[src/orchestrator/sanityGuard.ts:34–45](../src/orchestrator/sanityGuard.ts)~~ | ~~`checkSanityGuard` returns `passed: true` when no primary collection is set.~~ ✅ closed by M15: `checkSanityGuard` now returns `passed: false` with `code: 'no_primary_set'` when there's no primary AND at least one action would fire; vacuous (zero-action) runs still pass. |
| RV-1 | [src/mover/restore.ts:119](../src/mover/restore.ts) | Audit event is `restore_skipped` even though the function returns `kind:'restored'` (live tree already had matching content). The DB row is correctly marked `restored_at`. The audit/return-shape disagreement is confusing for grep-based audit review. |
| HM-1 | [src/mover/quarantine.ts:146](../src/mover/quarantine.ts), [restore.ts:90](../src/mover/restore.ts), [reconcile.ts:98](../src/mover/reconcile.ts) | `hashFileSync` blocks the event loop on every quarantine/restore/reconcile action. ROADMAP #13 covers worker-threading the **scanner** pool; the mover side is not tracked. For multi-GB files this stalls SSE and request handling. |
| RR-1 | route `/api/quarantine/run` 404 message | The error tells the user "re-run /api/scans first (server restarts clear the cache)" — but if the user disabled dry-run between the lost scan and the re-scan, the new scan re-evaluates the whole config. Behavior is correct; the message could mention this so a user doesn't expect identical actions on re-scan. Symptom of [decisions/0008-in-memory-runStore.md](decisions/0008-in-memory-runStore.md). |
| ED-1 | [src/mover/quarantine.ts:248–279](../src/mover/quarantine.ts) | Empty-dir sweep has no `isPathWithin(targetRoot, abs)` fence test in code path that runs before `rmdirSync` — wait, it does ([line 263](../src/mover/quarantine.ts)). False alarm; **closed**. (Kept here as a cross-check; remove on next pass.) |
| PG-1 | [src/mover/purge.ts](../src/mover/purge.ts) `dryRun` branch | Dry-run reports "would purge" but does not write any persistent record of the dry-run intent. `audit.jsonl` only sees `purge_complete` with the same shape, distinguished by `dryRun: true`. That works for grep, but no DB-side artifact survives. Probably fine — flag for discussion. |
| WK-1 | [src/scanner/walker.ts:85, 126](../src/scanner/walker.ts) | `fast-glob` is called with `suppressErrors: true`, so per-file glob errors (EACCES on a single file) are silently dropped. The directory-level pre-pass (`collectUnreadableDirs`) catches **directory** unreadability but not file-level. Tracked as ROADMAP backlog #14, marked deferred. Cross-listing here for visibility. |
| TR-1 | `tryRestore` path on quarantine size-mismatch | If `tryRestore` fails (mover [line 219](../src/mover/quarantine.ts)), the rolled-back-or-not state goes into the `error` column as a string. Reconcile re-checks dest, not src, so the orphaned action stays visible only in the audit page if/when the audit page surfaces error rows. Tracked as ROADMAP backlog #7. |

## Deferred test coverage

- ~~No test asserting `checkSanityGuard` blocks when no primary is set~~
  ✅ closed by M15 — covered by `tests/unit/sanityGuard.test.ts`,
  `tests/integration/quarantine.test.ts` (M15 case), and
  `tests/contract/api.test.ts` (M15 case).
- No test asserting `hashFileSync` is in fact called for very large files
  (would catch a hypothetical regression to "skip rehash on big files").
- No Playwright/headless-browser assertion for the type-to-confirm modal —
  M12.
- Integration test for `state.db-wal` left behind when the DB handle leaks
  on a thrown migration — covered in spirit by the `noServe` close-fence
  in `boot()`, but no explicit test.

## Items that ARE in ROADMAP and worth re-prioritising

These are flagged as "deferred" but feel material for shipping to real
data — included for the maintainer's ranking pass.

| ROADMAP # | summary | suggested re-priority |
|-----------|---------|------------------------|
| #6 | `insertPlannedAction` not in explicit transaction | Cosmetic; leave deferred. |
| #7 | Stranded actions when `tryRestore` fails are invisible to reconcile | **Promote** — relevant to the ship-to-real-data milestone. |
| #9 | Empty-dir cruft sweep ignores preset whitelist | **Promote** — could remove `Android/media/` if it ends up empty. |
| #11 | `path_prefix` unanchored | **Promote** — silent over-match risk. Schema-level enforcement. |
| #13 | Hashing on a worker thread | Defer until profiling on real data; main thread is fine for a one-time scan. |
| #21 | Scan results held in memory | **Promote** to M12 — restart between scan and quarantine is a likely real-world flow. Persist `actions[]` to `<target_root>/.dedupe/reports/<runId>-actions.json` so quarantine can rebuild from disk. |
| #25 | Cruft TOCTOU | Document only; null-hash cruft is low-stakes. |
| #27 | O(n²) name-collision groups | Add a soft cap (e.g. 1k pairs per basename) and a UI warning rather than a fix. |

## Roadmap entries added in this PR

These were added to [`ROADMAP.md`](../ROADMAP.md) alongside this docs set. The
authoritative status is in `ROADMAP.md`; this list is a quick cross-reference.

- **M14. Documentation drift cleanup.** ✅ closed in this PR — items D-1
  through D-7 above resolved.
- **M15. Sanity guard fail-closed without primary** (SG-1).
- **M16. Persist `runStore` to disk** (#21 promoted) so quarantine survives
  a restart.
- **M17. Audit-page surface for errored actions** (#7 promoted).
- **M18. Path-prefix anchoring** (#11 promoted).
- **M19. Mover-side hashing on a worker** (extends backlog #13 from the
  scanner pool to the mover/restore/reconcile call sites).
- **M20. First-run install wizard** — guided primary + preset confirmation,
  shape (1) server-launched flow only.
