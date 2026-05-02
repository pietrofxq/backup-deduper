# AGENTS.md — guidance for AI coding agents working on this repo

This is a safety-first deduplication tool. The single most important property is **no user data is silently lost or corrupted, ever**. The user named this as the bar in `PLAN.md`, and every other concern (perf, ergonomics, code beauty) sits below it.

These directives exist because past iterations of this codebase introduced regressions that a careful reviewer caught. Each rule below is rooted in a real bug that landed (and was reverted). Treat the list as a checklist before submitting any change that touches the safety-critical surface.

## Documentation index — read these for factual reference

This file is the rulebook (the *thou shalt nots*). For *what is and how it works*, the canonical references are:

- [`docs/README.md`](./docs/README.md) — index. Start here when you need to look something up.
- [`docs/architecture.md`](./docs/architecture.md) — process model + module map + data flow.
- [`docs/safety-model.md`](./docs/safety-model.md) — the 8 invariants, fences, two-phase commit (operational).
- [`docs/schema.md`](./docs/schema.md) — every SQLite table + column + index, with rationale.
- [`docs/api.md`](./docs/api.md) — HTTP routes + SSE wire format + error envelopes.
- [`docs/classifier.md`](./docs/classifier.md) — rule precedence, presets, whitelists.
- [`docs/config.md`](./docs/config.md) — config keys, defaults, gated keys.
- [`docs/conventions.md`](./docs/conventions.md) — code style, error handling, testing, cross-platform.
- [`docs/known-gaps.md`](./docs/known-gaps.md) — doc/code drift and deferred backlog items not yet in `ROADMAP.md`.
- [`docs/decisions/`](./docs/decisions/) — ADRs. **Read before reversing a choice.**
- [`docs/workflows/`](./docs/workflows/) — step-by-step guides for adding routes, presets, mover ops, schema changes.

When you change behavior in a way that contradicts a doc, fix the doc in the same commit. AGENTS.md rule #8 ("doc/code drift is a real bug class") applies to `docs/` too.

## The files where safety lives or dies

Documented in `PLAN.md` and re-verified each milestone. Any change touching these is high-stakes:

- `src/mover/quarantine.ts`
- `src/mover/reconcile.ts`
- `src/mover/restore.ts`
- `src/mover/purge.ts`
- `src/classifier/rules.ts`
- `src/db/migrations/0000_initial.sql`
- `src/target/guard.ts`
- `tests/integration/safetyInvariant.test.ts`
- `tests/integration/crashRecovery.test.ts`

For changes to these files: **always** run the property test (`npm test`) before committing, and **always** write a regression test for the edge you just changed.

## Hard rules

### 1. Never silently fall back when intent is ambiguous

Past bugs:
- `loadPresetByName` returned the Samsung preset when the requested name was unknown — a stale config silently classified with the wrong ruleset.
- `setPrimary` cleared the existing primary then UPDATEd a missing id — the system was left with no primary at all.
- `runScanJob` honored `opts.dryRun=false` even when `cfg.dry_run=true` — the report claimed "live" but quarantine refused.

Rule: if a request is malformed, stale, or conflicts with persisted state, **throw a structured error**. No fallbacks. Surface as 4xx in the API.

### 2. Treat every external string as untrusted, including filesystem and DB

Past bugs:
- The embedded UI built `innerHTML` from filenames returned by the API → XSS waiting on a malformed filename.
- `restoreOne` trusted `action.dest_abs_path` without checking it lay under `<target_root>/.dedupe-trash/` → tampered DB row could move arbitrary files.
- `purge` had a case-sensitive `startsWith` path fence that drive-letter casing could bypass on Windows.

Rule: when a string crosses into an `fs` operation, a `<dom>.innerHTML`, a SQL string, or a shell call, **validate or escape at the boundary**. For path containment, use `isPathWithin(parent, child)` (path.relative-based) — never `startsWith`. For HTML, use `textContent`/`createElement`, never template strings.

### 3. Two-phase commit means re-verify on the second phase

Past bug: `reconcilePending` checked dest existence and called `markActionExecuted` without re-stating size or re-hashing — a partial dest from an interrupted rename would be marked executed.

Rule: any code path that promotes a "pending" row to "complete" MUST re-read the file from disk and verify size + sha256 match the recorded values. Trust nothing across a process boundary.

### 4. Permission errors must surface, not silently shrink the tree

Past bug: `fast-glob` with `suppressErrors:true` swallowed EACCES on subdirectories. `scanAll` saw zero files there, `deleteStaleFiles` cleared the rows, and the next run treated those files as gone.

Rule: when a walk could miss a subtree (permission, transient I/O), **fail the run** with a structured error. Never let `last_seen_run` cleanup run while we have reason to believe parts of the tree were unreadable.

### 5. Mover invariants enforce the same fence three times

The mover module has three operations that move bytes inside the trash:
- `quarantine` → moves into `.dedupe-trash/`
- `purge` → deletes from inside `.dedupe-trash/`
- `restore` → moves out of `.dedupe-trash/` back into the live tree

All three MUST enforce `isPathWithin(<target_root>/.dedupe-trash/, ...)` on the trash side, AND `isPathWithin(<target_root>, ...)` on the live-tree side. If you add a fourth mover, copy the fence; do not assume the DB row is trustworthy.

### 6. Cross-platform safety is a line item, not an afterthought

Past bugs:
- `new URL(import.meta.url).pathname` returns `/C:/...` on Windows; passing that to `fs.realpathSync` throws.
- Tests hard-coded `/etc/passwd` as an "outside the trash" target; failed on Windows runners.
- `db.client.close()` was missing in `boot()`; tests passed on Linux because `rm -rf` can unlink open files, but Windows held the file lock and EBUSY'd.
- The purge path fence used case-sensitive `startsWith`; drive-letter casing variance on Windows could refuse legitimate paths.

Rule: every `fs.*` call, every path concatenation, every test fixture goes through this checklist:
- Does it work on Windows where paths are case-insensitive?
- Does it work on Windows where open file handles block `unlink`?
- Does it use `fileURLToPath(import.meta.url)` (not `new URL().pathname`)?
- Does it support paths longer than 260 chars (route through `toLongPath()` for absolute paths)?
- Does the test create its own fixtures inside `os.tmpdir()` instead of relying on `/etc/...`?

### 7. Don't trust types that compile but don't typecheck strictly

Past bugs:
- `App` type defined as `FastifyInstance<...extends infer _ ? never : never>` — both branches resolved to `never`, the type was unusable, but TS happily compiled it.
- Test mocks declared `bindDbUuid: (uuid, r) =>` (2 args) while the real interface takes 3; vitest transpiled successfully.

Rule:
- Run `npx tsc -p tsconfig.json --noEmit` AND `npx tsc -p tsconfig.test.json --noEmit` before committing — both must be clean.
- Type test mocks with the real interface they're standing in for (`const deps: TargetGuardDeps = ...`).
- If a type uses conditional `infer`, work out by hand what each branch resolves to.

### 8. Doc/code drift is a real bug class

Past bugs (each one a separate Copilot finding):
- `src/mover/quarantine.ts` doc said "Refuse if dest already exists"; code called `uniqueDest(...)`.
- `ROADMAP.md` claimed "no shell calls"; `sentinel.ts` ran `attrib +H` on Windows.
- `src/scanner/walker.ts` doc said ">100 segments produces a warning"; code used `>= 100`.
- `src/scanner/walker.ts` doc said "per-entry stat errors collected"; fast-glob's `suppressErrors:true` dropped them.
- `src/db/schema.ts` had an index named `idx_file_basename` that indexed full `rel_path`.

Rule: when changing a function's behavior, **read its docstring first** and update it in the same edit. When renaming a function/index/symbol, grep for the old name across `*.md` AND `*.ts` AND comments.

### 9. Use real type-shape constraints in tests

If a unit test mocks a dependency:
- Type the mock as the real interface (`const deps: SomeInterface = {...}`)
- Don't widen the interface to make tests easier

The targetGuard test mock drifted from the production interface for two whole iterations because the runtime test transpiler doesn't strict-check types. The compile-step tsconfig.test.json exists exactly to catch this — run it.

### 10. PR checklist before submitting

Run, in order:
1. `npx tsc -p tsconfig.json --noEmit` — production code typechecks
2. `npx tsc -p tsconfig.test.json --noEmit` — tests typecheck
3. `npm test` — full suite green
4. `npm run build` — dist build produces a working binary
5. Smoke test the built binary against a tmp dir — does `/health` respond? Does `PUT /config` with a gated key still 400?
6. Read every doc comment touched by the diff — does it still describe the code accurately?
7. For any new path/string crossing into an `fs.*` or DOM call: explicit validation at the boundary?
8. For any new mover/restore/purge code: `isPathWithin` fence on both sides?

## Process directives

### When user feedback flags a regression

1. **Reproduce first.** Read the file:line they reference. Confirm the diagnosis with your own eyes, not the reviewer's words.
2. **Fix and add a regression test in the same commit.** The test must FAIL on the bug and PASS after the fix. Without that, the regression can recur.
3. **Update related docstrings if the behavior changed.** See rule 8.

### When the user asks you to use a specific dependency

If the user says "use library X instead of writing it by hand": do the migration in one focused commit, run the suite, and do not introduce additional changes in the same commit. Past pattern: I swapped Drizzle, fast-glob, and the type-provider in three separate commits and each was easy to review.

### When you're about to do something destructive

The destructive operations in this codebase are:
- `fs.unlinkSync` (only `purge` should call this)
- `fs.renameSync` (only `quarantine`/`restore` should call this)
- `fs.rmSync({recursive:true})` (only test cleanup)
- `db.delete(...)` (rare; only in cache cleanup and intentional path deletions)
- `git push --force` (never without explicit user instruction)
- Modifying CI config in ways that could let a failing test merge

Before each: confirm the surrounding fence (path containment, db row state, audit log entry). If the surrounding code does not have a fence, add one before adding the destructive call.

### When tests pass but feel wrong

A green suite is not the same as a correct suite. Past examples from this PR:
- The safety-invariant property test passed at 200 numRuns even though the oracle was broken (it didn't exclude `.dedupe-trash` from the live walk, so orphaned trash files were counted as reachable).
- The purge "outside trash" test passed because it relied on `/etc/passwd` existing — which it didn't on Windows runners.

If a test feels weak, **plant the failure mode and assert the test fails**. Then revert. The oracle correctness regression in `safetyInvariant.test.ts` does this explicitly.

## What to never do

- Never `git push --force` to `main` or any shared branch without explicit user instruction.
- Never `--no-verify` past a pre-commit hook to bypass it.
- Never widen a TypeScript interface to make a test compile.
- Never silently catch and discard an error in a destructive code path.
- Never assume an `fs.*` call works the same on Linux and Windows.
- Never add a new mover/destructive operation without the path containment fence.
- Never trust `db.<column>` content for filesystem operations without re-verifying it lies within the expected boundary.
- Never copy a hash from one row to another without re-reading the file. The hash is a snapshot; bytes can change.

## Critical-files diff discipline

When the diff touches any file under `src/mover/`, `src/classifier/`, `src/target/`, or `src/db/migrations/`:

- Re-read PLAN.md sections "Safety invariants" and "Classifier rule precedence" before editing.
- Run `npm test` twice: once before the change, once after, and confirm only the expected count changed.
- For any new branch in the mover, write the corresponding `crashRecovery.test.ts` case before writing the implementation.
- For any new classifier rule, add a corresponding `tests/unit/classifier.test.ts` row and assert the precedence (cruft → duplicate → name-collision → keep) is preserved.
