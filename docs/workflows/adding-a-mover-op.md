# Adding a mover / destructive operation

> **Read [safety-model.md](../safety-model.md) and the
> [`AGENTS.md`](../../AGENTS.md) "Critical-files diff discipline" section
> end-to-end before opening this file. This is the single most dangerous
> kind of change you can make in this codebase.**

The existing destructive operations are:

| op | file | invariant |
|----|------|-----------|
| `quarantine` | [src/mover/quarantine.ts](../../src/mover/quarantine.ts) | rename src → `.dedupe-trash/`, two-phase commit |
| `restore` | [src/mover/restore.ts](../../src/mover/restore.ts) | rename trash file → live tree, conflict-aware |
| `purge` | [src/mover/purge.ts](../../src/mover/purge.ts) | `unlink` from trash after retention |

If you're adding a fourth (or extending one), the checklist below is
non-negotiable.

## Pre-flight

Before you write code:

1. **Open an ADR draft** in [`../decisions/`](../decisions/) describing
   what you're adding and why. Keep it short, but capture the tradeoff.
2. **Identify the safety invariant your op extends or breaks.** If it
   breaks one of the 8 in [safety-model.md](../safety-model.md), stop —
   talk to a maintainer.
3. **Decide which path-fence pair applies.** Every destructive op fences
   both sides:
   - live-tree side: `isPathWithin(targetRoot, …)`
   - trash side: `isPathWithin(trashDir, …)` AND `realpathSync` if you
     touch any user-controllable path.

## The mandatory checklist

Every destructive op MUST:

- [ ] Validate inputs at the boundary. Re-fence DB-derived paths with
  `isPathWithin` — never trust `dest_abs_path` or `src_rel_path` blindly.
- [ ] Re-stat **and** re-hash before the destructive call (when a hash
  is available). The classifier's hash is not trusted across the
  classify→move gap.
- [ ] Insert/update the DB row **before** the fs operation. The "planned"
  state must be persisted before bytes move; the "executed" state only
  after a post-op verify.
- [ ] Verify the op landed (post-`renameSync` `lstatSync`, etc.) before
  marking it executed.
- [ ] Audit-log via `appendAudit(targetRoot, '<event>', {...})`. Both
  happy path (`<op>_complete`) and refusal (`<op>_skip`) cases.
- [ ] Run inside `withMutationLock(...)` at the route layer.
- [ ] Be reentrant after a kill — `reconcilePending` must either promote
  the row to `executed` or to `error`. Never re-rename. Update reconcile
  to know about the new op's state machine if it's not isomorphic to
  quarantine's.
- [ ] Have at least one `tests/integration/<op>.test.ts` covering the
  happy path **and** the crash-between-row-insert-and-rename window.
- [ ] Have a `tests/integration/crashRecovery.test.ts` case if the new
  op introduces a new pending state.
- [ ] Have a unit test for any new path-containment check (model on
  [tests/unit/safetyGuards.test.ts](../../tests/unit/safetyGuards.test.ts)).
- [ ] Be added to the property test
  ([tests/integration/safetyInvariant.test.ts](../../tests/integration/safetyInvariant.test.ts))
  if the op affects whether primary content is reachable. **The headline
  invariant covers your op now**; if it doesn't, the op or the test is
  wrong.

## Skeleton

```ts
// src/mover/widgetize.ts
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { isPathWithin, fromDbRelPath } from '../paths/relpath.js';
import { toLongPath } from '../paths/winLong.js';
import { sentinelPaths } from '../target/sentinel.js';
import { hashFileSync } from '../hasher/sha256.js';
import { appendAudit } from '../audit/log.js';

export interface WidgetizeInput {
  db: Db;
  targetRoot: string;
  // … op-specific inputs
}

export interface WidgetizeOutcome {
  kind: 'done' | 'skipped' | 'errored';
  // …
}

/**
 * What this op does, in one sentence.
 *
 * Procedure (must match the code below — keep in sync):
 *   1. Look up the row; refuse if it's not in <expected state>.
 *   2. Re-verify the file hash (if recorded).
 *   3. Reconstruct paths via fromDbRelPath + path.join.
 *   4. Fence both sides with isPathWithin.
 *   5. INSERT/UPDATE the planned row.
 *   6. fs.renameSync (or fs.unlinkSync, if this is a purge-style op).
 *   7. Post-op verify.
 *   8. Mark executed.
 */
export function widgetize(input: WidgetizeInput): WidgetizeOutcome {
  const { db, targetRoot } = input;
  const { trashDir } = sentinelPaths(targetRoot);

  // 1. Look up
  const row = /* getX(db, …) */;
  if (!row) return { kind: 'skipped' };
  if (/* wrong state */) return { kind: 'skipped' };

  // 2. Re-verify
  if (row.sha256_hex) {
    const fresh = hashFileSync(/* path */);
    if (fresh !== row.sha256_hex) return { kind: 'errored' /* … */ };
  }

  // 3-4. Reconstruct + fence
  const srcAbs = path.join(targetRoot, /* … */);
  if (!isPathWithin(targetRoot, srcAbs)) {
    return { kind: 'errored' /* … */ };
  }
  const destAbs = /* … */;
  if (!isPathWithin(trashDir, destAbs)) {
    return { kind: 'errored' /* … */ };
  }

  // 5-7. Plan, do, verify.
  // INSERT row;
  // fs.renameSync(toLongPath(srcAbs), toLongPath(destAbs));
  // post-stat, etc.

  // 8. Mark + audit
  // markX(db, row.id);
  appendAudit(targetRoot, 'widgetize_complete', { /* … */ });
  return { kind: 'done' };
}
```

## Reconcile

If your op introduces a new pending state, extend
[src/mover/reconcile.ts](../../src/mover/reconcile.ts). The current
matrix handles `executed_at IS NULL AND error IS NULL` pending actions;
if your op's lifecycle uses different columns, add the case explicitly.

**Reconcile must NEVER re-rename.** It only updates bookkeeping. Any new
filesystem op requires a new run, where the standard re-verify-before-do
gate runs.

## Wiring

1. Route: add a POST under [src/server/routes/](../../src/server/routes/).
   Wrap in `withMutationLock`. See [adding-an-api-route.md](adding-an-api-route.md).
2. apiClient + queryKeys: see same workflow.
3. UI page: depends on the page. The UI should disable the action button
   while the request is in flight (TanStack Query's `isPending`).

## Anti-patterns

- **Don't** call `fs.renameSync`/`fs.unlinkSync` outside `src/mover/` and
  test cleanup.
- **Don't** copy the `dest_abs_path` from one row to another. The hash
  is a snapshot; bytes can change.
- **Don't** silence errors in the destructive code path. Surface as a
  structured error via the route's 4xx mapping; let the user see what
  failed.
- **Don't** add a fourth path fence and assume the existing three cover
  it. The fence applies per call; copy the call.
- **Don't** widen `withMutationLock` to allow concurrency "for performance".
  The sequential mover is a feature — interleaving renames doubles the
  reconcile matrix.

## Last gate

Before merging:

1. `npm run typecheck && npm run typecheck:web` — both clean.
2. `npm test` — full suite green.
3. `npm run test:thorough` — property test at numRuns=500 green.
4. Read every doc comment touched by the diff — does it still match
   the code? (See [`AGENTS.md`](../../AGENTS.md) rule #8.)
