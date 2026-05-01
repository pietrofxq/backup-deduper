# Architecture Decision Records

Each ADR captures a single decision: what was chosen, what was rejected,
and why. ADRs are **not** how-to docs — read them when you're tempted to
reverse a choice and want to know what tradeoff someone already weighed.

## Format

```
# 0NNN — <short title in active voice>

**Status:** Accepted | Superseded by 0NNN | Deprecated
**Date:** YYYY-MM
**Touches:** <load-bearing files>

## Context
What was the problem? What constraints?

## Decision
What did we pick?

## Consequences
What's better. What's worse. What gets harder if we ever change this.

## Alternatives considered
Briefly: what was rejected and why.
```

## Index

| # | Title | Status |
|---|-------|--------|
| [0001](0001-no-electron-no-playwright.md) | Local web UI in browser; no Electron, no Playwright in CI | Accepted |
| [0002](0002-target-sentinel-uuid.md) | Target identity via sentinel UUID, not volume serial | Accepted |
| [0003](0003-quarantine-not-delete.md) | Rename to quarantine; never `unlink` outside `purge` | Accepted |
| [0004](0004-two-phase-commit-mover.md) | Two-phase commit for every file move | Accepted |
| [0005](0005-sync-better-sqlite3.md) | `better-sqlite3` synchronous API as a feature, not a bug | Accepted |
| [0006](0006-fast-glob-deviation.md) | Use `fast-glob` instead of hand-rolling `fs.opendir` | Accepted (deviation from PLAN) |
| [0007](0007-localhost-cors.md) | Localhost-only CORS allowlist | Accepted |
| [0008](0008-in-memory-runStore.md) | Scan results live in an in-memory cache, not the DB | Accepted (revisit in M12) |
| [0009](0009-zod-end-to-end.md) | One zod schema per route, validating both request and response | Accepted |
| [0010](0010-web-types-not-shared.md) | Web app does not import server zod schemas | Accepted |

## When to write a new ADR

- You're about to reverse or significantly modify a choice listed above.
- You're adding a fundamental capability (a new mover, a new persistence
  mechanism, a new IPC protocol).
- You're picking between two approaches that aren't obviously equivalent.

## When NOT to write a new ADR

- Renaming a function. Adding a column. Refactoring an internal API.
- Routine bug fixes.
- Anything that fits in a commit message.
