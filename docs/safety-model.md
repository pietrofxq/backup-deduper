# Safety model

> **The single most important property of this codebase: no user data is
> silently lost or corrupted, ever.** Every other concern (perf, ergonomics,
> code beauty) sits below this. (See [`AGENTS.md`](../AGENTS.md).)

This doc is the operational reference for the safety machinery. If you are
about to touch any file under `src/mover/`, `src/classifier/`,
`src/target/`, or `src/db/migrations/`, **read this end-to-end first**.

## The 8 invariants

Each invariant is operationalized somewhere in the code; the file:line
references below are the load-bearing implementations.

### 1. No direct deletions in v1

"Removal" = `fs.renameSync` into `<target_root>/.dedupe-trash/`. Actual
unlink lives in `purge` only and is gated by `retention_days`.

- Quarantine rename: [src/mover/quarantine.ts:205](../src/mover/quarantine.ts)
- Real unlink: [src/mover/purge.ts:116](../src/mover/purge.ts) — the **only**
  `fs.unlinkSync` on user data in the codebase.

If you add another caller of `fs.unlinkSync` or `fs.rmSync({recursive:true})`
to anything other than test cleanup, **you are violating this invariant**.
Open an ADR before doing so.

### 2. Two-phase commit for every move

The order, encoded in [src/mover/quarantine.ts:79–245](../src/mover/quarantine.ts):

1. `lstatSync` source (skip if ENOENT)
2. Re-hash source; refuse if it differs from `action.file.sha256_hex`
3. Compute `uniqueDest` (collision → ` (1)`, ` (2)`…)
4. `isPathWithin(trashDir, destAbs)` fence
5. `mkdir -p` parent
6. `INSERT INTO quarantine_action ... (planned_at = now)` — row written **before** rename
7. Same-volume root check
8. `fs.renameSync(src → dest)`
9. `lstatSync(dest)` post-move; size mismatch → `tryRestore`, mark error
10. `UPDATE executed_at = now, verified_at = now`
11. `DELETE FROM file ...`

A kill between (6) and (10) is recoverable: `reconcilePending`
([src/mover/reconcile.ts](../src/mover/reconcile.ts)) re-verifies dest and
only then promotes `executed_at`.

### 3. Re-verify under fresh hash before quarantine

The classifier's hash is **not trusted** across the classify→move gap.
[src/mover/quarantine.ts:143–164](../src/mover/quarantine.ts) re-hashes from
disk and refuses on mismatch.

Cruft files may have null hashes (the classifier doesn't require a hash to
flag cruft). For those, size match is the strongest signal we have at
reconcile-time. **Documented limitation** — see [known-gaps.md](known-gaps.md).

### 4. Target-sentinel gate

On first run, generate a UUID, write to `<target_root>/.dedupe/target-id.txt`
**and** the `target` table (singleton, `id=1`).

On every start: live UUID must match DB UUID, else **refuse to run** with a
structured `TargetGuardError` ([src/target/guard.ts](../src/target/guard.ts)).

Outcomes:

| sentinel | DB | result |
|----------|----|--------|
| absent   | absent | initialize both (first run) |
| present  | absent | `TargetGuardError('db_uuid_missing')` — refuse |
| absent   | present | `TargetGuardError('sentinel_missing')` — refuse |
| match    | match  | OK; update `target_root_abs` if path changed (remount) |
| mismatch | mismatch | `TargetGuardError('uuid_mismatch')` — refuse |

The sentinel travels with the data — drive remap or letter change is
non-destructive.

### 5. Sanity guard

Refuses to run a quarantine pass when:

- No primary collection is set **and** the run would do anything to the
  tree — at least one file action OR at least one empty-directory removal
  (`code: 'no_primary_set'`). Without a primary, the dedup tiebreak has no
  anchor — quarantining files (or rmdir'ing folders) in that state is
  exactly the footgun this guard exists to prevent. Vacuous (zero-action,
  zero-emptyDir) runs still pass.
- The cached scan's primary id differs from the current primary (any
  shift counts: null→A, A→B, A→null). The classifier shapes its keeper-
  picking around whichever collection was primary at scan time — the
  within-collection canonical winner respects the primary's path
  priority, and cross-collection dedup picks losers relative to the
  primary-wins rule. Applying that stale plan after a primary switch
  could quarantine files inside the user's just-marked source-of-truth
  collection. `runQuarantineJob` compares `cached.scanPrimaryId` to
  `getPrimary(db)?.id` and refuses on any mismatch (`code:
  'no_primary_set'` when scan-time was null, `code: 'primary_changed'`
  when both were set but differ). The user must rescan.
- Planned actions would touch more than 50% of files **or** more than 70%
  of bytes of the primary collection (`code: 'pct_exceeded'`).

All three are bypassable via the explicit `ignoreSanityGuard: true`
override.

[src/orchestrator/sanityGuard.ts](../src/orchestrator/sanityGuard.ts) +
[src/orchestrator/quarantineJob.ts](../src/orchestrator/quarantineJob.ts)
(stale-plan refusal lives in the job, not the guard, because the cached
scan-time guard is the canonical signal).

### 6. Restore never overwrites

If the original path is occupied by content with a **different** hash:

- with `allowSidecar=false` (default): refuse, return `kind:'errored'`.
- with `allowSidecar=true`: write to `<basename> (restored)<ext>` (then
  `uniqueDest` if even that is taken).

If the occupant has the **same** hash, `restoreOne` does no rename and just
updates `restored_at`.

[src/mover/restore.ts:99–134](../src/mover/restore.ts).

### 7. Preset whitelists win

Cruft classification checks **whitelist first**, *before* both always-on
rules and preset rules. The Samsung preset relies on this so
`Android/media/` (WhatsApp media) is never swept even though the rest of
`Android/` is.

[src/classifier/cruft.ts:30–43](../src/classifier/cruft.ts).

### 8. Same-volume rename only

[src/mover/quarantine.ts:199](../src/mover/quarantine.ts) asserts
`path.parse(src).root === path.parse(dest).root` before every rename. A
cross-volume rename would silently degrade to copy-then-unlink, which is
**not atomic** and breaks invariants 1 and 2.

## Path containment fences (`isPathWithin`)

Every destructive operation MUST fence both sides against
[src/paths/relpath.ts:30 `isPathWithin`](../src/paths/relpath.ts):

| operation | live-tree fence | trash fence |
|-----------|-----------------|-------------|
| `quarantine` | `isPathWithin(targetRoot, srcAbs)` | `isPathWithin(trashDir, destAbs)` |
| `restore`    | `isPathWithin(targetRoot, sourceAbs)` | `isPathWithin(trashDir, action.dest_abs_path)` |
| `purge`      | n/a (no live-tree write) | `isPathWithin(trashRealPath, destRealPath)` after `realpathSync` on **both sides** |

If you add a fourth mover, copy the fence; **do not assume the DB row is
trustworthy**. The `dest_abs_path` column is just a string — anything that
treats it as a path-on-disk without re-fencing is a vulnerability.

## Why `path.relative` and not `startsWith`

Past bug: `purge` used a case-sensitive `startsWith` fence; on Windows, drive
letter casing variance (`C:\` vs `c:\`) could either pass an attacker-chosen
path or refuse a legitimate one. `path.relative()` matches the FS's case
sensitivity per platform and rejects `..` escapes deterministically.

[src/paths/relpath.ts:30](../src/paths/relpath.ts).

## The headline property test

`tests/integration/safetyInvariant.test.ts` runs `fast-check` over randomized
trees and asserts:

> For any sequence of scan + classify + quarantine ops (no purge), every
> byte-content present in the primary collection before the run is still
> reachable somewhere afterwards — original location, another copy at the
> same hash in the primary, or in the quarantine with a `quarantine_action`
> row pointing back.

50 cases per CI run; `npm run test:thorough` runs 500. **A failure here
must block the merge unconditionally.**

## When you're about to do something destructive

The destructive operations in this codebase are:

- `fs.unlinkSync` — only `purge` may call this. Anywhere else is a violation.
- `fs.renameSync` — only `quarantine` and `restore`. Anywhere else: ADR first.
- `fs.rmSync({recursive:true})` — only test cleanup.
- `db.delete(...)` — rare; only in cache cleanup and intentional path deletions.

Before each, confirm:

1. The corresponding `isPathWithin` fence runs on both sides.
2. The DB row has been written (for `renameSync`) **before** the rename.
3. An audit-log entry is written via `appendAudit`.
4. There's a corresponding `tests/integration/*` case covering the exact
   crash window between row insert and rename.

If any of those four are missing, the change is incomplete. Add them or
revert.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules-as-checklist.
- [conventions.md](conventions.md) — broader code conventions including
  error handling and cross-platform.
- [decisions/0003-quarantine-not-delete.md](decisions/0003-quarantine-not-delete.md)
- [decisions/0004-two-phase-commit-mover.md](decisions/0004-two-phase-commit-mover.md)
