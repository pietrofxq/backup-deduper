# 0004 — Two-phase commit for every file move

**Status:** Accepted
**Date:** 2024-02
**Touches:** [src/mover/quarantine.ts](../../src/mover/quarantine.ts), [src/mover/reconcile.ts](../../src/mover/reconcile.ts)

## Context

We need crash recovery for the mover. A `kill -9` or power loss between
"we decided to quarantine X" and "X is in `.dedupe-trash/`" must leave
the tool in a state from which it can resume — not crash, not lose data,
not commit a partial move.

Three failure windows:

1. Process dies before the rename. Source is still in place.
2. Process dies during the rename. POSIX/NTFS rename is atomic — no
   partial state on disk, but the DB doesn't know yet.
3. Process dies after the rename, before the DB knows.

Without explicit handling, all three look the same to a naïve caller:
"action is in DB, file is somewhere".

## Decision

For every action, in this exact order ([quarantine.ts:79–245](../../src/mover/quarantine.ts)):

1. `lstatSync` source.
2. Re-hash source; reject if it differs from the recorded hash.
3. Compute `uniqueDest` (pure path math, no fs writes).
4. `isPathWithin` fence on dest.
5. `mkdir -p` parent.
6. **`INSERT INTO quarantine_action (... planned_at = now)`** — row
   exists *before* any rename.
7. `fs.renameSync(src → dest)`.
8. Post-move `lstatSync(dest)`; size mismatch → `tryRestore`, mark error.
9. **`UPDATE executed_at + verified_at`** — only after post-move verify.
10. `DELETE FROM file ...`.

On startup, [reconcilePending](../../src/mover/reconcile.ts) walks every
row with `executed_at IS NULL AND error IS NULL`. For each:

- Dest present, size and hash match recorded values → mark executed.
- Dest present, mismatch → mark error (partial write or wrong file).
- Dest missing, src present → mark error (rename never started).
- Both missing → mark error (state unknown, needs human review).

**Reconcile never re-renames.** It only updates bookkeeping. New fs
operations require a new run, where the standard re-verify-before-move
gate runs.

## Consequences

Better:

- A `kill -9` between phase 1 and phase 2 is **always** recoverable.
  Either the rename happened (reconcile promotes to executed) or it
  didn't (reconcile marks error, future scan re-plans).
- The DB is the source of truth for "what we intended to do"; the
  filesystem is the source of truth for "what actually happened".
  Reconcile reconciles them.
- The headline property test
  ([safetyInvariant.test.ts](../../tests/integration/safetyInvariant.test.ts))
  is provable end-to-end against this protocol.

Worse:

- One extra `INSERT` per action. Negligible; a few hundred per scan.
- The "mark error" code paths after rename failure (`tryRestore`) are
  themselves a small two-phase: try to put the file back, then write
  the error. If `tryRestore` itself fails, the action is stranded — see
  ROADMAP backlog #7.

## Invariant

> Any `quarantine_action` row with `planned_at` set and `executed_at`
> NULL means the rename either has not happened or is unverified. Any
> row with `executed_at` set means the dest exists and matches the
> recorded size + hash.

This invariant is what makes the safety property test pass.

## Alternatives considered

- **Mark executed before the rename** — rejected: a crash between mark
  and rename produces a row claiming the file is in quarantine when
  it's still in the live tree. `restoreOne` would refuse, the user is
  stuck.
- **WAL-style append-only log on disk** — overkill; SQLite's WAL gives
  us this for free.
- **Skip the DB row, just tail `audit.jsonl`** — audit log is for
  humans/grep; it's not transactional and a half-written line on power
  loss is not recoverable.
