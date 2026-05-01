# Filesystem layout

Everything the tool produces lives under `<target_root>`. Travels with the
data: drive remap, mountpoint change, copy to another machine — the state,
audit log, and quarantine come along.

## Layout

```
<target_root>/                       e.g. E:\, /mnt/photos, ~/dedupe-test
├─ <CollectionA>/                    user data — untouched except by quarantine moves
├─ <CollectionB>/                    "
│
├─ .dedupe/                          tool state (POSIX-hidden by dot prefix; +H on Windows)
│  ├─ target-id.txt                  the sentinel UUID (matches target.target_id_uuid)
│  ├─ state.db                       better-sqlite3 main file
│  ├─ state.db-wal                   WAL — never edit manually
│  ├─ state.db-shm                   shared memory — never edit manually
│  ├─ audit.jsonl                    append-only audit log (see below)
│  └─ reports/
│     └─ <runId>.json                full DryRunReport per scan
│
└─ .dedupe-trash/                    quarantine root (also dot-prefixed + +H on Windows)
   └─ <ISO-timestamp>-run-<runId>/
      └─ <CollectionName>/
         └─ <original/relative/path>/<file>
```

### What's NOT generated despite docs claims

- `<target_root>/.dedupe/state.db.backup-YYYY-MM-DD` — README/PLAN claim
  weekly snapshots; **not implemented**. See [known-gaps.md](known-gaps.md).
- `<target_root>/.dedupe/app.log` — README/PLAN claim a structured pino log;
  **not implemented**. The Fastify default logger writes to stdout only;
  pino is a transitive Fastify dep, not used directly. See
  [known-gaps.md](known-gaps.md).
- `<target_root>/.dedupe/config.json` — config lives in the `config` SQL
  table, not a JSON file.

### Why `.dedupe/` is dot-prefixed even on Windows

POSIX hides dot-prefixed files by default; Windows doesn't. We additionally
run `attrib +H <dedupe-dir>` on first creation
([src/target/sentinel.ts:61–67](../src/target/sentinel.ts), best-effort,
errors swallowed). Dot prefix alone is enough for most file managers
(Explorer with "show hidden" off, IntelliJ default, etc.) and the +H is
defense-in-depth.

The `.dedupe-trash/` folder gets the same treatment.

## audit.jsonl format

One JSON object per line, no trailing comma, append-only. UTF-8.

Every entry includes `ts` (ISO 8601 UTC) and `event`. Other fields depend
on the event.

Events emitted today (grep `appendAudit(` for the canonical list):

| event | source | payload |
|-------|--------|---------|
| `boot` | main.ts | `{ uuid, initialized, remounted, targetRoot, osPlatform }` |
| `scan_complete` | scanJob | full report meta |
| `scan_failed` | scanJob | `{ runId, error }` |
| `scan_aborted` | scanJob | `{ runId }` |
| `reconcile` | reconcile.ts | counts |
| `reconcile_error` | reconcile.ts | `{ actionId, reason, destAbsPath }` |
| `quarantine_skip` | quarantine.ts | `{ reason, srcAbs, ... }` |
| `quarantine_error` | quarantine.ts | `{ srcAbs, error }` |
| `quarantine_complete` | quarantineJob | summary + guard |
| `quarantine_failed` | quarantineJob | `{ runId, error }` |
| `restore_complete` | restore.ts | `{ actionId, finalPath, outcomeKind }` |
| `restore_skipped` | restore.ts | `{ actionId, reason }` |
| `purge_refused` | purge.ts | `{ actionId, dest, reason, ... }` |
| `purge_error` | purge.ts | `{ actionId, error }` |
| `purge_complete` | purge.ts | summary |
| `purge_failed` | purge.ts | `{ runId, error }` |
| `dry_run_disabled` | quarantineJob | `{ at }` |
| `empty_dir_removed` | quarantine.ts | `{ abs }` |
| `empty_dir_skip` | quarantine.ts | `{ abs, error }` |

The audit log is **separate from the SQLite audit data** intentionally —
the DB is authoritative for state; the JSONL is grep-able and survives
even if `state.db` is unrecoverable.

## Quarantine path layout

```
.dedupe-trash/
└── 2024-04-29T16-27-00.123Z-run-42/
    ├── Backup s22/
    │   └── DCIM/
    │       └── Camera/
    │           └── IMG_0001.jpg
    └── Backup s24 (27-02-2024)/
        └── Android/
            └── data/
                └── com.something/
                    └── cache/
                        └── thing.exo
```

Notes:

- ISO timestamps contain `:` which is illegal on NTFS — replaced with `-`
  in the run-dir name only ([quarantine.ts:48](../src/mover/quarantine.ts)).
- The collection name is preserved as a directory level so a single
  quarantine run keeps cross-collection paths distinguishable.
- Within the collection level, the **original relative path** is
  reproduced. Restore is just `rename` of `dest` back to `targetRoot/<col>/<rel>`.

## What lives in `<target_root>` and why

| concern | why colocated with data |
|---------|-------------------------|
| `state.db` | drive remount → DB and data move together (no orphaned cache pointing at a vanished drive) |
| `audit.jsonl` | same |
| `.dedupe-trash/` | quarantine *must* be on the same volume so renames are atomic — see [safety-model.md](safety-model.md) §8 |
| `target-id.txt` | the target's identity. Travels with the data, not the install. |
| `reports/<runId>.json` | persists the dry-run report so the user can re-open it after the in-memory `runStore` cache is gone |

## What does NOT live in `<target_root>`

- The Node executable, `dist/`, `node_modules/` — those are the install.
- Any UI state (the SPA holds its query cache in memory; nothing is
  persisted client-side).
- OS-level Defender exclusions, scheduled tasks (Phase 2).
