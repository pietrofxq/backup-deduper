# Schema reference

SQLite database at `<target_root>/.dedupe/state.db`. WAL mode,
`synchronous=FULL`, `foreign_keys=ON`.

The schema is defined in Drizzle:
[src/db/schema.ts](../src/db/schema.ts). Migrations are
**generated** by `drizzle-kit generate` into
[src/db/migrations/](../src/db/migrations/) — do not handwrite SQL there.
The migration runner is custom, deliberately tiny:
[src/db/index.ts:79–113 `migrate()`](../src/db/index.ts).

> **Naming note:** PLAN.md mentioned `001_initial.sql`. Drizzle generated
> `0000_initial.sql`. The migration runner accepts any `^\d+_.+\.sql$`, so
> the real file is what matters. AGENTS.md has been updated; PLAN may still
> say 001 — see [known-gaps.md](known-gaps.md).

## ERD (text form)

```
target (singleton)                     preset
─ id = 1 PK                           ─ id PK auto
─ target_id_uuid                      ─ name UNIQUE
─ target_root_abs                     ─ cruft_rules_json
─ os_platform CHECK in (3)            ─ whitelist_json
─ bound_at                            ─ path_priority_json
                                      ─ is_builtin
                                      ─ created_at

collection                             config (key/value)
─ id PK auto                          ─ key PK
─ rel_path UNIQUE                     ─ value
─ is_primary  ◀── partial UNIQUE      ─ updated_at
              where is_primary = 1
─ created_at

file
─ id PK auto                                          ┌── run
─ collection_id ─FK→ collection (cascade)             ─  id PK auto
─ rel_path                                            ─  kind CHECK in (4)
─ size                                                ─  status CHECK in (5)
─ mtime_ms                                            ─  dry_run
─ sha256_hex (nullable until hashed)                  ─  config_json snapshot
─ last_seen_run                                       ─  started_at
─ UNIQUE(collection_id, rel_path)                     ─  finished_at
─ INDEX(sha256_hex) WHERE NOT NULL
─ INDEX(collection_id), INDEX(rel_path)

quarantine_action                                review_item
─ id PK auto                                    ─ id PK auto
─ run_id ─FK→ run (RESTRICT)                    ─ run_id ─FK→ run (cascade)
─ collection_id ─FK→ collection (RESTRICT)      ─ basename
─ src_rel_path                                  ─ a_collection_id ─FK→ collection
─ dest_abs_path                                 ─ a_rel_path, a_sha256_hex, a_size
─ size, sha256_hex                              ─ b_collection_id ─FK→ collection
─ reason                                        ─ b_rel_path, b_sha256_hex, b_size
─ planned_at, executed_at, verified_at,         ─ status CHECK in 4
  restored_at, purged_at                        ─ created_at
─ error
```

## Tables

### `target` — drive-identity gate (singleton)

| col | type | notes |
|-----|------|-------|
| `id` | INTEGER PK | always 1 (`CHECK id = 1`) |
| `target_id_uuid` | TEXT | matches sentinel file at `<target_root>/.dedupe/target-id.txt` |
| `target_root_abs` | TEXT | last-seen absolute path; updated on remount |
| `os_platform` | TEXT | `CHECK IN ('win32','linux','darwin')` |
| `bound_at` | TEXT | ISO datetime (default `datetime('now')`) |

Used by [src/target/guard.ts](../src/target/guard.ts) on every boot. See
[safety-model.md](safety-model.md) §4.

### `preset` — cruft rules + whitelists + path priorities

JSON blobs are validated by zod when loaded
([src/presets/types.ts](../src/presets/types.ts), see
[classifier.md](classifier.md)).

| col | type | notes |
|-----|------|-------|
| `id` | INTEGER PK auto | |
| `name` | TEXT UNIQUE | |
| `cruft_rules_json` | TEXT | array of `{id, kind, pattern, description?}` |
| `whitelist_json` | TEXT | array of `{kind, pattern}` |
| `path_priority_json` | TEXT | array of path-prefix strings, in priority order |
| `is_builtin` | INTEGER | 1 for built-in (Samsung, Minimal); 0 for user-added |
| `created_at` | TEXT | |

Built-ins are seeded on every boot via `seedBuiltinPresets`
([src/presets/registry.ts](../src/presets/registry.ts)).

### `collection` — top-level subfolders under `target_root`

| col | type | notes |
|-----|------|-------|
| `id` | INTEGER PK auto | |
| `rel_path` | TEXT UNIQUE | forward-slash, no leading slash |
| `is_primary` | INTEGER | 0 or 1 |
| `created_at` | TEXT | |

**Partial unique index** `idx_collection_one_primary` enforces "at most one
row has `is_primary = 1`" at the SQL level — making "two primaries" a
constraint violation, not a code bug.

### `file` — one row per live (non-quarantined) file

| col | type | notes |
|-----|------|-------|
| `id` | INTEGER PK auto | |
| `collection_id` | INTEGER FK | `ON DELETE CASCADE` |
| `rel_path` | TEXT | DB form (forward slashes; see [src/paths/relpath.ts](../src/paths/relpath.ts)) |
| `size` | INTEGER | bytes |
| `mtime_ms` | INTEGER | `Math.floor(stat.mtimeMs)` |
| `sha256_hex` | TEXT NULL | NULL until first hash; NULL also on hash error |
| `last_seen_run` | INTEGER NULL | `run.id` of the most recent scan that observed this file |

Indexes:

- `UNIQUE(collection_id, rel_path)` — keeps `upsertFile` deterministic.
- `idx_file_sha256 WHERE sha256_hex IS NOT NULL` — partial; speeds dedup grouping.
- `idx_file_collection`, `idx_file_relpath` — point lookups during scan.

**Cache key** for skipping re-hash: `(size, mtime_ms)` per
`(collection_id, rel_path)`. Either changes → re-hash. Row not seen this
run → `deleteStaleFiles(db, runId)` removes it at end-of-scan.

A row is **deleted** (not flagged) when:
- the file is moved into quarantine ([quarantine.ts:244](../src/mover/quarantine.ts)), or
- the source disappeared mid-quarantine ([quarantine.ts:120](../src/mover/quarantine.ts)), or
- it wasn't seen by `last_seen_run` ([scanner/index.ts:143](../src/scanner/index.ts)).

A row is **re-upserted** on restore ([restore.ts:148](../src/mover/restore.ts)).

### `run` — a unit of work

| col | type | notes |
|-----|------|-------|
| `id` | INTEGER PK auto | |
| `kind` | TEXT | `CHECK IN ('scan','quarantine','purge','restore')` |
| `status` | TEXT | `CHECK IN ('running','completed','crashed','failed','aborted')` |
| `dry_run` | INTEGER | 1/0; default 1 |
| `config_json` | TEXT | snapshot of relevant config + opts at run start |
| `started_at` | TEXT | |
| `finished_at` | TEXT NULL | set by `setRunStatus` |

Lifecycle: `running` → one of `completed | crashed | failed | aborted`.
`crashed` is set by `reconcilePending` on the next boot for any run that
was still `running` when the previous process died.

### `quarantine_action` — the audit-log core

| col | type | notes |
|-----|------|-------|
| `id` | INTEGER PK auto | |
| `run_id` | INTEGER FK | `ON DELETE RESTRICT` — runs can't be deleted while their actions exist |
| `collection_id` | INTEGER FK | `ON DELETE RESTRICT` |
| `src_rel_path` | TEXT | DB form |
| `dest_abs_path` | TEXT | absolute; **never trust without `isPathWithin(trashDir,…)`** |
| `size` | INTEGER | recorded **before** the rename |
| `sha256_hex` | TEXT NULL | NULL for cruft-without-hash actions |
| `reason` | TEXT | `cruft_os_metadata` \| `cruft_preset_<id>` \| `cruft_empty_folder` \| `duplicate_within_collection` \| `duplicate_cross_collection` |
| `planned_at` | TEXT | inserted at INSERT time |
| `executed_at` | TEXT NULL | set after post-move stat (sub-second precision via `strftime('%Y-%m-%d %H:%M:%f','now')`) |
| `verified_at` | TEXT NULL | set with `executed_at` |
| `restored_at` | TEXT NULL | |
| `purged_at` | TEXT NULL | |
| `error` | TEXT NULL | populated by `markActionError` on any of: rename failure, post-move size mismatch, reconcile size/hash mismatch |

Indexes:

- `idx_qa_run` — list actions for a given run.
- `idx_qa_pending` partial on `WHERE executed_at IS NULL AND error IS NULL` —
  used by `getPendingActions` (the reconcile target).
- `idx_qa_active` on `(executed_at, restored_at, purged_at)` — used by
  `listActiveActions` (UI quarantine page).

State machine of one action:

```
                   INSERT
                   planned_at = now
                          │
        ┌─────────────────┴─────────────────┐
        ▼                                   ▼
  (rename happens)                     error set
        │                              (terminal)
        ▼
   executed_at + verified_at = now
        │
        ├──────────────────┐
        ▼                  ▼
   restored_at       purged_at
   (terminal)       (terminal)
```

`restored_at` and `purged_at` are mutually exclusive; the relevant code paths
([restore.ts:55–57](../src/mover/restore.ts) and `listActiveActions` in
[queries.ts](../src/db/queries.ts)) refuse to act when either is set.

### `review_item` — name collisions for human review

| col | type | notes |
|-----|------|-------|
| `id` | INTEGER PK auto | |
| `run_id` | INTEGER FK | `ON DELETE CASCADE` |
| `basename` | TEXT | the colliding filename (no path) |
| `a_*`, `b_*` | … | the two sides; `a_collection_id`, `a_rel_path`, `a_sha256_hex`, `a_size`; same for `b_…` |
| `status` | TEXT | `CHECK IN ('open','kept_both','quarantined_a','quarantined_b')` |
| `created_at` | TEXT | |

In v1 only `kept_both` decisions are wired through the API — wiring
`quarantined_a`/`quarantined_b` to a side-quarantine mover is Phase 2.

### `config` — KV with zod validation in app code

| col | type | notes |
|-----|------|-------|
| `key` | TEXT PK | |
| `value` | TEXT | always JSON-stringified by `setConfigValue` |
| `updated_at` | TEXT | |

Schema validation lives in app-land
([src/config/schema.ts](../src/config/schema.ts)), not in the DB.
**Gated keys** (`dry_run`, `dry_run_disabled_at`) are rejected by
`PUT /api/config` at both the request schema layer and the service layer.

See [config.md](config.md) for the full key/default list.

### `schema_version` — migration bookkeeping (not in Drizzle schema)

Created by the migration runner itself; **deliberately omitted** from
`schema.ts` so `drizzle-kit generate` doesn't try to recreate it.

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Pragmas applied at open

[src/db/index.ts:43–50](../src/db/index.ts):

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;  -- bumped from NORMAL in M11 (backlog #5)
```

`synchronous=FULL` adds an extra fsync per commit; the throughput hit is
negligible for our workload (a few hundred commits per scan, no bulk-insert
hot paths) and the safety dividend is essential.

## Time formats

- `started_at`, `created_at`, `bound_at`, etc. — `datetime('now')` produces
  `YYYY-MM-DD HH:MM:SS` (second precision).
- `executed_at` — `strftime('%Y-%m-%d %H:%M:%f','now')` produces
  `YYYY-MM-DD HH:MM:SS.SSS` (sub-second). Bumped from `datetime('now')` in
  M11 so `(executed_at, verified_at)` ordering disambiguation works at
  sub-second granularity.
- `audit.jsonl` `ts` and SSE `ts` — JS `Date.toISOString()` (UTC `Z`).

Parse via [src/db/datetime.ts `parseSqliteDatetime`](../src/db/datetime.ts).
It accepts both formats and ISO with `Z`.

## Adding a new column or table

See [workflows/changing-the-schema.md](workflows/changing-the-schema.md).
