# 0006 — Use `fast-glob` instead of hand-rolling `fs.opendir`

**Status:** Accepted (deviation from PLAN.md)
**Date:** 2024-04
**Touches:** [src/scanner/walker.ts](../../src/scanner/walker.ts)

## Context

PLAN.md called for a hand-rolled `fs.opendir` async iterator (~80 LOC) so
we could control symlink rejection, depth tracking, and per-dir error
handling exactly the way we need.

In practice, the user requested we prefer long-trusted community
dependencies over hand-rolling tree-walk semantics. `fast-glob` is the
de-facto Node walker for the same use case (cross-platform, follows
`.gitignore`-style patterns, has the right options for symlink behavior).

## Decision

Use `fast-glob` for the file and directory walks in
`walkCollection`. Configure with:

```ts
{
  dot: true,
  onlyFiles: true,        // or onlyDirectories
  followSymbolicLinks: false,
  suppressErrors: true,
  stats: true,
  markDirectories: false,
  objectMode: true,
}
```

Add a **synchronous BFS pre-pass** (`collectUnreadableDirs` in
[src/scanner/walker.ts](../../src/scanner/walker.ts)) that walks the tree
once and records EACCES/EPERM directories as `kind: 'unreadable'` errors.
The orchestrator throws `UnreadableSubtreeError` and refuses the run when
any are present.

## Consequences

Better:

- Walker is ~50 LOC of glue + `fast-glob` config; less to maintain.
- The community has fixed many edge cases we'd hit (Windows long paths,
  reparse points, junctions).
- Symlink rejection: `followSymbolicLinks: false` plus an explicit lstat
  fallback inside our loop.

Worse:

- `suppressErrors: true` swallows per-file glob errors silently. Our
  pre-pass catches directory-level unreadability but not, say, an EACCES
  on a single file inside an otherwise-readable directory. **Tracked as
  ROADMAP backlog #14**, deferred. The pre-pass is the safety-critical
  half — losing visibility on a whole subtree is what causes
  `last_seen_run` to forget user data; losing visibility on one file
  just means we skip it.
- We can't cancel mid-walk. `fast-glob` doesn't take an `AbortSignal`.
  Cancellation polls the signal between hashed files, which is the
  granularity that actually matters for UX.

## Alternatives considered

- **Hand-rolled `fs.opendir`** — original PLAN. Rejected per user
  preference for community deps; the surface to maintain (symlinks,
  long paths, reparse points, Windows junctions) is non-trivial.
- **`globby`** — wraps `fast-glob`, doesn't add value.
- **`readdirp`** — an option, but `fast-glob`'s `objectMode` + `stats`
  feature gives us size + mtime in the same call as the walk.

## When to revisit

If we hit a real bug rooted in `suppressErrors: true` (per-file errors
that mask a real safety problem), the right next step is to switch to
`fast-glob`'s streaming API and capture errors via the stream's `'error'`
event, not to rewrite the walker.
