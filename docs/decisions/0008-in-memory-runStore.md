# 0008 — Scan results live in an in-memory cache, not the DB

**Status:** Accepted (revisit in M12 / consider M16 in [known-gaps.md](../known-gaps.md))
**Date:** 2024-04
**Touches:** [src/orchestrator/runStore.ts](../../src/orchestrator/runStore.ts), [src/server/routes/quarantine.ts](../../src/server/routes/quarantine.ts)

## Context

`POST /api/quarantine/run` needs the planned actions for a given scan
run. Two options:

1. Persist the classified `actions[]` and `emptyDirs[]` to the DB or a
   JSON sidecar, keyed by `runId`.
2. Hold them in an in-memory cache, lookup-by-runId.

The actions list is large (potentially tens of thousands of rows) and
disposable — once `quarantine_action` rows are inserted, the
"planned-but-not-yet-executed" representation has served its purpose.

## Decision

Hold the most recent 10 scan results in an in-memory `Map<number,
ScanJobResult>`, evicting oldest first. Sticky for the life of the
process; lost on restart.

The quarantine route returns a 404 with the message:

> "scan result not found in cache; re-run /api/scans first (server
> restarts clear the cache)"

…which tells the user exactly what to do.

## Consequences

Better:

- Zero serialization overhead for the largest data structure in the
  scan flow.
- No schema changes when we modify the action shape.
- A dry-run report file is still written to
  `<target_root>/.dedupe/reports/<runId>.json`, so the **report** is
  durable; only the live action list is volatile.
- Restart between scan and quarantine forces a re-scan — which is
  actually safer: config may have changed between scan and quarantine,
  and a stale action list could now violate sanity guard or whitelist
  rules.

Worse:

- Restart between scan and quarantine costs a re-scan (15–25 minutes on
  the user's 155 GB dataset). For a single user scenario this is
  annoying; for a long-running server it would be unacceptable.
- The 404 message has to explain the policy, otherwise it looks like a
  bug.
- The "actions to execute" representation is in two places (the in-mem
  cache and the report JSON); only the cache has the *typed*
  `PlannedAction[]` form the mover consumes.

## Alternatives considered

- **Persist to DB** — would need an `action_plan` table or a
  `pending_actions_json` column on `run`. Cheap to write, but couples
  schema to the action shape. Rejected for v1.
- **Persist to a sidecar JSON next to the report** — easiest middle
  ground; a follow-up could implement this without schema changes. See
  [known-gaps.md](../known-gaps.md) (suggested M16).
- **Re-classify on quarantine call** — would re-walk the disk, defeating
  the whole point of the dry-run.

## When to revisit

Promote to "persist to disk" the moment the user reports lost work due
to a server restart. The change is mechanical: the same
`actions[]` we already serialize for the report JSON gets a typed copy
under a separate filename, loaded on cache miss.
