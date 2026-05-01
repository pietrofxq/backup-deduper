# 0002 — Target identity via sentinel UUID, not volume serial

**Status:** Accepted
**Date:** 2024-02
**Touches:** [src/target/sentinel.ts](../../src/target/sentinel.ts), [src/target/guard.ts](../../src/target/guard.ts)

## Context

A safety-critical question: when the tool boots against a `target_root`,
how does it know it's pointed at the same data as last time? Possibilities
the user could cause without bad intent:

- Drive letter remap on Windows (`E:` → `F:`).
- Mountpoint change on Linux/macOS.
- Typo in the launch command — accidentally pointing at a different
  folder that happens to have a `Backup s22/` subdir.
- Drive replaced with a different physical disk.

If we accept any of these silently, we'd reuse the SQLite cache against
the wrong files: the `file` rows would name paths that no longer exist,
the dedup engine would compare hashes from a different dataset, and a
quarantine pass could move data the user never meant to dedupe.

An earlier draft used the **NTFS volume serial** as the identity (queried
via `wmic`/PowerShell). That worked on Windows but was Windows-only and
shell-call-laden.

## Decision

On first setup, generate a UUID
(`crypto.randomUUID()`), write it to:

1. `<target_root>/.dedupe/target-id.txt`, and
2. The DB row `target` (singleton).

On every boot:

- Both present and matching → OK. Update `target_root_abs` if the path
  changed (drive remount).
- Both absent → first run; initialize.
- Anything else → refuse with a structured `TargetGuardError`.

## Consequences

Better:

- **Cross-platform.** No PowerShell, no `wmic`, no `diskutil`. Just `fs`.
- **Travels with the data.** A drive remount or letter change is
  non-destructive — the sentinel and DB are inside `target_root` and move
  together; the tool just confirms the new path on next launch.
- **Tamper-evident.** A sentinel/DB mismatch is an immediate refusal with
  the actual UUIDs in the error message, not a silent fallback.
- **Testable.** Tests mock the deps interface
  ([TargetGuardDeps](../../src/target/guard.ts)) instead of running shell
  commands.

Worse:

- A user who manually deletes `<target_root>/.dedupe/target-id.txt` and
  re-runs gets a refusal until they also delete the DB. Documented in
  the error message.
- We can't detect "different drive but identical content" (e.g. user
  copied data to a new disk, kept `.dedupe/` along with it). That's the
  desired behavior — the data moved, the identity moved with it.

## Alternatives considered

- **NTFS volume serial via `wmic`** — original draft. Rejected: Windows
  only, shell-call, and breaks if the user reformats but uses the same
  partition.
- **Hash of the first 100 file paths** — rejected: changes when the user
  adds a file in a way that changes ordering; non-deterministic.
- **No identity gate, just trust the path** — rejected: opens the door to
  cache-pointing-at-wrong-data bugs that would silently corrupt user
  data via the dedup engine.
