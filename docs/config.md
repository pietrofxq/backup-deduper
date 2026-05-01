# Config reference

Source of truth: [src/config/schema.ts](../src/config/schema.ts).
Loader/patcher: [src/config/loader.ts](../src/config/loader.ts).
Wire: `GET /api/config` and `PUT /api/config`. See [api.md](api.md).

Stored in the `config` KV table. Each value is JSON-stringified on the way
in and `JSON.parse`d on the way out.

## Keys

| key | type | default | gated? |
|-----|------|---------|--------|
| `active_preset` | `string` | `'Samsung Android phone backup'` | no |
| `retention_days` | `int 1..365` | `30` | no |
| `dry_run` | `boolean` | `true` | **yes** |
| `dry_run_disabled_at` | `string \| null` (ISO datetime) | `null` | **yes** |
| `sanity_guard_files_pct` | `float 0..1` | `0.5` | no |
| `sanity_guard_bytes_pct` | `float 0..1` | `0.7` | no |

`DEFAULT_CONFIG` is `ConfigSchema.parse({})` — anything missing from the DB
falls through to the schema default.

## Gated keys — what "gated" means

`PUT /api/config` rejects any payload mentioning a gated key. Two layers:

1. **Schema layer** ([src/server/routes/config.ts:16–25](../src/server/routes/config.ts)):
   `ConfigSchema.omit(GATED_CONFIG_KEYS).partial().strict()` — `.strict()`
   makes any unknown key (including the omitted ones) a 400 instead of
   being silently stripped.
2. **Service layer** ([src/config/loader.ts](../src/config/loader.ts)):
   `patchConfig` throws `GatedConfigKeyError` if any gated key reaches it.

The only legitimate path to flip `dry_run` to `false` is
`POST /api/config/disable-dry-run` with the exact `CONFIRMATION_PHRASE`
("`I have reviewed the dry-run report`").

When the phrase matches, `disableDryRun` ([src/orchestrator/quarantineJob.ts:97](../src/orchestrator/quarantineJob.ts))
sets both `dry_run = false` and `dry_run_disabled_at = now`, in one save.

> **Re-enabling dry-run.** There is no API to flip `dry_run` back to `true`
> from outside. If you need it, use `setConfigValue` directly via a script.
> The conscious omission is to keep "the user accidentally turned safety
> back on between scan and quarantine" out of the threat model.

## Why `sanity_guard_*_pct` are not gated

These thresholds raise or lower the bar but never disable it. The hard
override path (`ignoreSanityGuard=true` per call) is non-persistent —
intentionally so: leaving a persistent override on by accident defeats the
mechanism. A persistent flag (`sanity_guard_override`) used to live in the
schema and was removed; see the in-file note in `schema.ts`.

## Adding a new key

1. Add the field to `ConfigSchema` in
   [src/config/schema.ts](../src/config/schema.ts) with a default.
2. If it's destructive to flip without confirmation, add it to
   `GATED_CONFIG_KEYS` in [src/config/loader.ts](../src/config/loader.ts).
3. If gated, add a confirmation-gated route under
   `/api/config/<your-key>-confirm` modeled on
   [src/server/routes/config.ts](../src/server/routes/config.ts).
4. Update [api.md](api.md) and this file.
5. Add a unit test in `tests/unit/` and a contract test for any new route.

## Reading config in your code

Always go through `loadConfig(db)` — never reach into `getConfigValue`
unless you have a reason. `loadConfig` merges with defaults; raw queries
will return `undefined` for unset keys and you will forget the default.
