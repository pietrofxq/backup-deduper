# 0003 — Rename to quarantine; never `unlink` outside `purge`

**Status:** Accepted
**Date:** 2024-02
**Touches:** all of [src/mover/](../../src/mover/)

## Context

The bar set for v1 is: *no user data is silently lost or corrupted, ever*.

A direct-delete dedup (the obvious implementation) is fast and frees disk
space immediately, but every bug in the classifier becomes a permanent
data loss event. The user explicitly said safety is the bar.

## Decision

- "Removal" in v1 is `fs.renameSync` of the source into
  `<target_root>/.dedupe-trash/<run-id>/...`. The bytes are still on disk;
  the user can `restore` for `retention_days` (default 30).
- The **only** caller of `fs.unlinkSync` on user data in the codebase is
  [src/mover/purge.ts](../../src/mover/purge.ts), and it runs as a
  separate, time-gated, never-auto-invoked job.
- Restore is a rename back. Same volume → atomic.

## Consequences

Better:

- A bug in the classifier produces a recoverable mistake, not a
  permanent one. The 30-day window is generous enough for any user to
  notice "wait, I'm missing photos".
- Crash recovery is straightforward — `reconcilePending` looks at
  filesystem state and DB rows and reconciles; no "did we delete this
  before or after the row?" branching.
- Same-volume rename is atomic on every supported filesystem.

Worse:

- Quarantine doesn't free disk space until purge. For a 155 GB dataset
  with 50% duplicates, the user temporarily holds 155 GB + quarantined
  bytes until purge.
- An attacker with shell access to `<target_root>` could in theory swap
  files in `.dedupe-trash/` between quarantine and restore. Mitigation:
  every restore re-verifies the recorded `sha256_hex` before renaming.

## Alternatives considered

- **Direct delete with confirmation gate** — rejected: confirmation
  fatigue defeats the gate, and the dry-run report alone isn't enough
  reassurance for a destructive op.
- **Recycle Bin / Trash integration** — rejected: cross-platform
  fragmentation (Trash on macOS, Recycle Bin on Windows, no canonical
  Linux equivalent), and these are user-managed, not tool-managed —
  retention semantics aren't ours to enforce.
- **Copy then delete** — rejected: not atomic, doubles disk use during
  the operation, and the partial-copy crash window is much worse than
  the partial-rename crash window (which is empty, since rename is
  atomic).

## See also

- [safety-model.md](../safety-model.md) — operational invariants.
- [0004-two-phase-commit-mover.md](0004-two-phase-commit-mover.md).
