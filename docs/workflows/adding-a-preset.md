# Adding a preset

A preset is a named bundle of `cruft_rules` + `whitelist` + `path_priority`
that the user picks from a dropdown. See [classifier.md](../classifier.md)
for what each field means and how matching works.

## Two kinds of presets

| kind | persistence | seeded? |
|------|-------------|---------|
| **Built-in** | shipped in code under [src/presets/](../../src/presets/), seeded into the `preset` table on every boot via `seedBuiltinPresets` | yes |
| User-added | inserted via the API (route TBD; not yet exposed in v1) | no |

This workflow is for **built-in** presets (the only kind v1 supports).

## Step 1 — Write the preset module

Add a file under [src/presets/](../../src/presets/) named
`<short-id>.ts`:

```ts
// src/presets/ios-backup.ts
import type { Preset } from './types.js';

export const IOS_BACKUP: Preset = {
  name: 'iOS device backup',
  description:
    'A preset for iTunes/Finder iOS backups. Excludes iCloud sync placeholders.',
  cruft_rules: [
    {
      id: 'manifest_db_journal',
      kind: 'basename',
      pattern: 'Manifest.db-journal',
      description: 'SQLite journal left after a partial sync',
    },
    {
      id: 'icloud_placeholder',
      kind: 'extension',
      pattern: '.icloud',
    },
  ],
  whitelist: [
    // Anything that would otherwise match a cruft rule but is real user data.
  ],
  path_priority: [
    // Most-canonical first.
    'Snapshot/',
  ],
};
```

The `name` must be unique — it's the natural-key lookup the user picks
from the UI dropdown. The `id` of each cruft rule shows up in audit
log reasons as `cruft_preset_<id>`; pick stable values (you'll see them
in production audit logs forever).

## Step 2 — Validate it

The `Preset` type is enforced by zod at load time
([src/presets/types.ts](../../src/presets/types.ts) and
[src/presets/registry.ts](../../src/presets/registry.ts)). Your preset
should compile without casts. If you find yourself adding `as Preset`,
something is wrong.

## Step 3 — Register it

Add the preset to the built-in registry. The actual symbol names matter —
the existing builtins use SCREAMING_SNAKE_CASE (`SAMSUNG_ANDROID`,
`MINIMAL`); follow the same convention:

```ts
// src/presets/registry.ts
import { SAMSUNG_ANDROID } from './samsung-android.js';
import { MINIMAL } from './minimal.js';
import { IOS_BACKUP } from './ios-backup.js';

const BUILTINS: ReadonlyArray<Preset> = [
  SAMSUNG_ANDROID,
  MINIMAL,
  IOS_BACKUP,           // ← new
];

export function builtinPresets(): ReadonlyArray<Preset> {
  return BUILTINS;
}
```

`seedBuiltinPresets` (also in `registry.ts`) is called on every boot and
upserts each row with `is_builtin = 1`. Existing rows with the same `name`
are updated, so you can safely tweak rules between releases without manual
migration.

## Step 4 — Test it

Add a unit test in [tests/unit/presets.test.ts](../../tests/unit/presets.test.ts):

```ts
test('iOS backup preset round-trips through zod', () => {
  expect(() => PresetSchema.parse(IOS_BACKUP)).not.toThrow();
});

test('iOS backup whitelist (if any) beats every cruft rule', () => {
  // Pick a path that matches both a whitelist entry and a cruft rule;
  // assert classifyCruft returns { kind: 'whitelisted' }.
});
```

If your preset has a whitelist, **always** add a test that proves the
whitelist beats the cruft rules. The Samsung preset's `Android/media/`
test is the canonical example
([tests/unit/classifier.test.ts](../../tests/unit/classifier.test.ts)) —
the consequence of getting this wrong is sweeping user content.

## Step 5 — Audit your `path_prefix` patterns

Every `path_prefix` pattern should end with `/` so it doesn't match
partial directory names (`Android/data` would over-match
`Android/database/foo` without the trailing slash). ROADMAP backlog #11
will eventually enforce this in the schema; until then it's manual.

## Step 6 — Document the preset

Update [classifier.md](../classifier.md) §"Built-in presets" with a brief
description of the new preset's rules and any notable whitelist entries.

## Anti-patterns

- **Don't** use `path_prefix` patterns without a trailing `/`. See above.
- **Don't** add a cruft rule for a path that is sometimes user data
  without a corresponding whitelist. The Samsung preset's lesson:
  `Android/data/` is cruft, but `Android/media/` (a sibling) is not, and
  the path_prefix matcher would otherwise sweep it.
- **Don't** rely on case-insensitive matching for filenames the OS
  treats case-insensitively. Our matchers are case-sensitive
  (`extension` lowercases both sides; the others don't); preset rules
  should use the canonical casing of the platform.
- **Don't** ship a preset whose name collides with a built-in. The
  upsert by name will overwrite the user's preset.
