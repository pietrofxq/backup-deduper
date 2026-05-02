# Conventions

Code style, error handling, testing, cross-platform. This is the
file-by-file rule book; for the safety-critical surface specifically, see
[safety-model.md](safety-model.md) and [`AGENTS.md`](../AGENTS.md).

## TypeScript

- `strict` and `noUncheckedIndexedAccess` are on for both
  [tsconfig.json](../tsconfig.json) and
  [tsconfig.test.json](../tsconfig.test.json). Both must `--noEmit` clean
  before committing.
- Run order: `npm run typecheck && npm run typecheck:web` and
  `npm test`.
- ESM only (`"type": "module"`). Internal imports end in `.js`
  (TypeScript ESM convention) — `import { foo } from './bar.js'` resolves
  to `bar.ts` at compile time.
- Avoid conditional `infer` types unless you've worked out by hand what
  every branch resolves to. AGENTS.md rule #7 was rooted in a real bug
  where both branches collapsed to `never`.
- Type test mocks with the **real** interface (`const deps:
  TargetGuardDeps = …`). Don't widen the interface to make a test compile.

## Imports

- Prefer named imports. Default imports only for `node:*` modules where it
  is the convention (`import fs from 'node:fs'`).
- Use the `node:` prefix consistently — `node:fs`, `node:path`,
  `node:crypto`, etc.
- The Drizzle client and the better-sqlite3 client share one file
  ([src/db/index.ts](../src/db/index.ts)) — never instantiate either
  outside of `openDb()`.

## Error handling

Three rules from `AGENTS.md` are load-bearing here. They aren't restrictive
for its own sake — each was rooted in a regression that landed and was
reverted.

### 1. Throw on ambiguity, never silently fall back

If a request is malformed, conflicts with persisted state, or names
something that doesn't exist:

```ts
// good — caller learns exactly what failed
throw new UnknownPresetError(`No preset named "${name}"`);

// bad — past pattern that produced a real bug
return loadPresetByName(name) ?? loadPresetByName('Samsung Android phone backup');
```

Surface as a structured error class (subclass `Error`, set `name`, attach
context as fields). Routes map error classes → 4xx codes. See
[src/server/routes/scans.ts:127–162](../src/server/routes/scans.ts) for
the canonical mapping pattern.

### 2. Validate or escape every external string at the boundary

- Filesystem: every `fs.*` operation goes through `isPathWithin` (and
  often `realpathSync`) to fence its inputs against `targetRoot` and
  `trashDir`. Even DB rows are external — the `dest_abs_path` column
  could be tampered with; never trust it without re-fencing.
- DOM: never `innerHTML = userString`. Use `textContent`/`createElement`.
- SQL: every query goes through Drizzle's typed builder
  (`db.q.<table>.…`) or a parameterized `.prepare(...).get(?)`. **Never**
  string-concatenate a user value into SQL.

### 3. Re-verify on the second phase of any two-phase commit

Any code path that promotes a "pending" row to "complete" MUST re-read
from disk and verify size + sha256 match the recorded values. Trust
nothing across a process boundary.

The mover, reconcile, and restore flows all do this; if you add a fourth,
copy the pattern.

### Permission errors must surface

When a walk could miss a subtree (EACCES/EPERM), **fail the run** with a
structured error. Never let `last_seen_run` cleanup run while we have
reason to believe parts of the tree were unreadable. See
[src/scanner/walker.ts collectUnreadableDirs](../src/scanner/walker.ts) and
the `UnreadableSubtreeError` it raises.

## Path handling

Three layers; mix them at your peril:

| layer | shape | who uses it |
|-------|-------|-------------|
| **DB form** | forward-slash, no leading slash, no `..` | `file.rel_path`, `quarantine_action.src_rel_path`, classifier rules, presets |
| **OS-native** | `path.sep`-separated | anything passed to `fs.*` |
| **Long form (Windows only)** | `\\?\C:\...`, `\\?\UNC\...` | passed to `fs.*` for paths potentially > 260 chars |

Conversions:

```ts
// DB → OS-native
fromDbRelPath(dbRel: string): string

// OS-native → DB form (rejects absolute, rejects `..` escapes)
toDbRelPath(rawRel: string): string

// OS-native → long form (no-op on POSIX)
toLongPath(absPath: string): string
```

Source: [src/paths/relpath.ts](../src/paths/relpath.ts) and
[src/paths/winLong.ts](../src/paths/winLong.ts).

`isPathWithin(parent, child)` returns `false` for `parent === child` (the
`path.relative()` result is `''`). Document this if it matters for your
caller; the mover treats parent === child as out-of-bounds, which is
intentional.

## Cross-platform

Every `fs.*` call, every path concatenation, every test fixture goes
through this checklist:

- Does it work on Windows where paths are case-insensitive?
- Does it work on Windows where open file handles block `unlink`? (We had
  a bug where `db.client.close()` was missing in `boot()` and
  `rm -rf .dedupe/` on Windows EBUSY'd; fix is `try/catch` around the
  close.)
- Does it use `fileURLToPath(import.meta.url)` (NOT `new URL().pathname`,
  which returns `/C:/...` with a leading slash on Windows)?
- Does it support paths longer than 260 chars (route through
  `toLongPath()` for absolute paths)?
- Does the test create its own fixtures inside `os.tmpdir()` instead of
  relying on `/etc/...`?

CI runs Linux + macOS + Windows; both Node 20 and Node 22. PR is gated on
green builds across the whole matrix.

## Database access

- New queries go in [src/db/queries.ts](../src/db/queries.ts). Don't inline
  SQL in route handlers or business logic.
- Prefer `db.q.<table>.…` (Drizzle) for typed queries. Use `db.client`
  only for migrations and the rare `pragma`/`prepare` that Drizzle can't
  express.
- Wrap multi-statement writes in `db.client.transaction(() => …)`. (We
  could add wider transaction wrapping; ROADMAP backlog #6 is about
  `insertPlannedAction` specifically.)

## Logging

Today: Fastify's default logger to stdout. `LOG_LEVEL=silent` disables in
tests. **There is no app-level pino logger** despite the dependency being
installed and PLAN/README claiming one — see [known-gaps.md](known-gaps.md).

When you need persistent structured records, use `appendAudit()` — it
writes JSONL to `<target_root>/.dedupe/audit.jsonl`.

## Testing

Five layers, all under [tests/](../tests/) and [web/src/](../web/src/):

| layer | tool | speed | runs on |
|-------|------|-------|---------|
| Unit | vitest | ms | Linux + macOS + Windows |
| Integration | vitest + real fs/SQLite | seconds | Linux + macOS + Windows |
| API contract | vitest + Fastify `.inject()` | seconds | Linux + macOS + Windows |
| Property | vitest + fast-check | seconds at numRuns=50 | Linux + macOS + Windows |
| UI component | vitest + Testing Library (React) | ms | Linux only |

**No browser E2E in CI** — see
[decisions/0001-no-electron-no-playwright.md](decisions/0001-no-electron-no-playwright.md).
A single Playwright test for the type-to-confirm flow is planned in M12.

### Integration test rules

- **Real tmp dirs**, never mock `fs`. Mocking hides exactly the
  cross-platform behavior we need to verify.
- Build fixtures via [tests/_helpers/tmp.ts](../tests/_helpers/tmp.ts) so
  every test cleans up.
- For Windows-only behaviors (locked files, long paths), gate the
  describe block: `describe.skipIf(!isWindows)`. Don't omit the test —
  you want CI to show "2 skipped" on Linux/macOS so the gate is visible.

### Property test rule

If a property test feels weak, **plant the failure mode and assert the
test fails**, then revert. The safety-invariant property test passed at
numRuns=200 with a broken oracle once (didn't exclude `.dedupe-trash/`
from the live walk so quarantined files counted as "still reachable" by
their original path). Always sanity-check by injecting the bug.

### Test typing

`tsconfig.test.json` typechecks under `strict` like production. Mocks must
be typed as the real interface they stand in for; don't widen interfaces
to make tests easier.

## Frontend conventions

- TanStack Query is the only data layer. Centralize keys in
  [web/src/lib/queryKeys.ts](../web/src/lib/queryKeys.ts) and invalidate
  via `qc.invalidateQueries(keys.X())` after mutations.
- Don't import server zod schemas; the apiClient redeclares the response
  types as plain TS interfaces. See
  [decisions/0010-web-types-not-shared.md](decisions/0010-web-types-not-shared.md).
- Tabular numbers everywhere a number is shown
  (`font-variant-numeric: tabular-nums`).
- Lucide icons; hairline borders; focus rings on every interactive
  element. Auto-dark via `prefers-color-scheme`.

## What never to do

(Verbatim from AGENTS.md "What to never do" — repeated here for findability.)

- Never `git push --force` to `main` or any shared branch without explicit
  user instruction.
- Never `--no-verify` past a pre-commit hook to bypass it.
- Never widen a TypeScript interface to make a test compile.
- Never silently catch and discard an error in a destructive code path.
- Never assume an `fs.*` call works the same on Linux and Windows.
- Never add a new mover/destructive operation without the path
  containment fence.
- Never trust `db.<column>` content for filesystem operations without
  re-verifying it lies within the expected boundary.
- Never copy a hash from one row to another without re-reading the file.
