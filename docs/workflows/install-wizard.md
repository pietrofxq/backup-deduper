# Building the install wizard (M20)

Step-by-step for the first-run wizard. Read [ROADMAP.md §M20](../../ROADMAP.md) first for context and scope. This doc is the **implementation guide** — the why-and-shape lives in the roadmap entry.

## Inventory

| concern | file |
|---------|------|
| New config key | [src/config/schema.ts](../../src/config/schema.ts) |
| First-run detection | [src/server/routes/health.ts](../../src/server/routes/health.ts) (or a new `/wizard/status` route) |
| Wizard-completion endpoint | new [src/server/routes/wizard.ts](../../src/server/routes/wizard.ts) |
| Collection preview endpoint | extend [src/server/routes/collections.ts](../../src/server/routes/collections.ts) |
| Wizard page | new [web/src/pages/Wizard.tsx](../../web/src/pages/Wizard.tsx) |
| Wizard step components | new under `web/src/pages/wizard/` |
| Routing redirect | [web/src/router.tsx](../../web/src/router.tsx) |
| API client | [web/src/lib/apiClient.ts](../../web/src/lib/apiClient.ts) |
| Query keys | [web/src/lib/queryKeys.ts](../../web/src/lib/queryKeys.ts) |
| Tests | server contract + web component |
| Docs to update | [docs/api.md](../api.md), [docs/config.md](../config.md), this file |

## Step 1 — Add the config key

```ts
// src/config/schema.ts
export const ConfigSchema = z.object({
  // … existing keys …
  wizard_completed_at: z.string().nullable().default(null),
});
```

**Do NOT** add this to `GATED_CONFIG_KEYS`. The wizard-complete route is the
only intended writer, but a generic `PUT /api/config` set is fine as a fallback;
the safety property is "the wizard sets primary + preset before flipping the
flag", not "only the wizard can flip the flag". A user who sets the flag by
hand is opting out — that's their choice.

Add a unit test in
[tests/unit/](../../tests/unit/) confirming default is `null` and round-trip
through `loadConfig`/`saveConfig` works.

## Step 2 — Wizard-status route

Pick one of two:

**Option A** — extend `/api/health`:

```ts
// src/server/routes/health.ts
app.get('/health', { schema: { response: { 200: HealthResponse } } }, async () => {
  const cfg = loadConfig(deps.db);
  const primary = getPrimary(deps.db);
  return {
    ok: true as const,
    targetRoot: deps.targetRoot,
    uuid: getTarget(deps.db)?.target_id_uuid ?? null,
    osPlatform: detectPlatform(),
    wizardRequired: cfg.wizard_completed_at === null && primary === null,
  };
});
```

**Option B** — new dedicated route:

```ts
// src/server/routes/wizard.ts
app.get('/wizard/status', { … }, async () => ({
  wizardRequired: cfg.wizard_completed_at === null && primary === null,
  hasPrimary: primary !== null,
  hasCompleted: cfg.wizard_completed_at !== null,
}));
```

**Recommendation:** Option A. The SPA already calls `/api/health` on boot; piggy-backing the wizard flag avoids an extra round-trip on every page load. Just expand the response zod schema.

The `wizardRequired === true` condition is `wizard_completed_at === null && primary === null`. The two-way AND matters: a user who set a primary via the Settings page on a previous run shouldn't be re-prompted.

## Step 3 — Collection preview endpoint

The wizard's "Discovered collections" screen needs file counts without paying
for a full hash pass. Extend
[src/server/routes/collections.ts](../../src/server/routes/collections.ts):

```ts
app.get(
  '/collections/preview',
  { schema: { response: { 200: z.array(CollectionPreviewRow) } } },
  async () => {
    const out: CollectionPreviewRow[] = [];
    for (const c of listCollections(deps.db)) {
      const walk = await walkCollection(path.join(deps.targetRoot, c.rel_path));
      out.push({
        id: c.id,
        relPath: c.rel_path,
        fileCount: walk.files.length,
        emptyDirCount: walk.emptyDirs.length,
        totalBytes: walk.files.reduce((a, f) => a + f.size, 0),
        unreadable: walk.errors.some((e) => e.kind === 'unreadable'),
      });
    }
    return out;
  },
);
```

Don't trigger a real `scanAll` here — preview must be fast and read-only. If
any collection reports `unreadable: true`, the wizard should refuse to
advance and show the user the affected paths (mirrors the
`UnreadableSubtreeError` policy).

## Step 4 — Wizard-complete endpoint

```ts
// src/server/routes/wizard.ts (new file)
import { z } from 'zod';
import { withMutationLock } from '../../orchestrator/mutex.js';
import { getPrimary } from '../../db/queries.js';
import { loadConfig, saveConfig } from '../../config/loader.js';
import { appendAudit } from '../../audit/log.js';

export class WizardIncompleteError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Cannot complete wizard: missing ${missing.join(', ')}`);
    this.name = 'WizardIncompleteError';
  }
}

const CompleteResponse = z.object({
  ok: z.literal(true),
  completedAt: z.string(),
});

const ErrorResponse = z.object({
  error: z.string(),
  missing: z.array(z.string()).optional(),
});

export async function registerWizardRoutes(app, deps) {
  app.post(
    '/wizard/complete',
    {
      schema: { response: { 200: CompleteResponse, 400: ErrorResponse } },
    },
    async (req, reply) => {
      const cfg = loadConfig(deps.db);
      const primary = getPrimary(deps.db);
      const missing: string[] = [];
      if (!primary) missing.push('primary_collection');
      // active_preset has a default; only check if you want to require explicit pick
      if (missing.length > 0) {
        return reply.code(400).send({
          error: 'wizard prerequisites not met',
          missing,
        });
      }
      const completedAt = new Date().toISOString();
      cfg.wizard_completed_at = completedAt;
      saveConfig(deps.db, cfg);
      appendAudit(deps.targetRoot, 'wizard_completed', { completedAt });
      return { ok: true as const, completedAt };
    },
  );
}
```

Idempotence: a second `POST` returns the existing `completedAt` without
overwriting. Add this if the audit-log noise from re-completion matters.

The mutex isn't strictly needed (this is a small config write), but if you're
unsure, wrap it in `withMutationLock` — cost is negligible.

## Step 5 — Wizard page

```tsx
// web/src/pages/Wizard.tsx
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ConfirmTargetStep } from './wizard/ConfirmTargetStep';
import { CollectionsStep } from './wizard/CollectionsStep';
import { PrimaryStep } from './wizard/PrimaryStep';
import { PresetStep } from './wizard/PresetStep';

export function Wizard() {
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const navigate = useNavigate();
  // … render the right step component, pass setStep as `onNext`
  // The final step calls POST /api/wizard/complete then navigate('/')
}
```

Each step component is small and tested in isolation:

- `ConfirmTargetStep` — type-to-confirm pattern (reuse from M12 if it lands first).
- `CollectionsStep` — read-only table of `/api/collections/preview` results; refuse to advance if any `unreadable: true`.
- `PrimaryStep` — radio over `/api/collections`; calls `POST /api/collections/primary` on advance; required.
- `PresetStep` — dropdown over `/api/presets`; calls `PUT /api/config { active_preset }` on advance.

Use TanStack Query mutations with `qc.invalidateQueries()` on each step's
successful POST so the wizard stays consistent if the user navigates back.

## Step 6 — Router redirect

```tsx
// web/src/router.tsx
const rootRoute = new Route({
  /* … */
  beforeLoad: async () => {
    const health = await apiClient.health();
    if (health.wizardRequired && location.pathname !== '/wizard') {
      throw redirect({ to: '/wizard' });
    }
  },
});
```

Don't forget the `/api/wizard/...` routes themselves are excluded from the
redirect (they're API paths, not SPA routes; the redirect is on the SPA root
loader).

## Step 7 — Tests

**Server contract** ([tests/contract/api.test.ts](../../tests/contract/api.test.ts)):

- `GET /api/health` includes `wizardRequired: true` on a fresh boot with no primary.
- `POST /api/wizard/complete` with no primary → 400 + `missing: ['primary_collection']`.
- `POST /api/wizard/complete` happy path → 200, sets `wizard_completed_at`, audit entry written.
- After completion, `GET /api/health` → `wizardRequired: false`.
- Idempotence: second `POST /api/wizard/complete` doesn't overwrite the timestamp.

**Web component** (`web/src/pages/__tests__/Wizard.test.tsx`):

- Each step renders.
- Cannot advance from `PrimaryStep` without a selection.
- `CollectionsStep` blocks advance when a collection has `unreadable: true`.
- Final step navigates to `/` after a successful complete.

## Step 8 — Docs

- Update [docs/api.md](../api.md): add `/api/wizard/status` (or expanded
  `/api/health`), `/api/wizard/complete`, `/api/collections/preview`.
- Update [docs/config.md](../config.md): add `wizard_completed_at` to the
  config keys table.
- Mention the wizard in [README.md](../../README.md) "How to run" — first-run
  experience now starts with the wizard.

## Anti-patterns

- **Don't** store target_root in config. It's already in `target.target_root_abs`,
  managed by the sentinel guard. The wizard reads it; it doesn't write it.
- **Don't** add a path-entry field. The chosen shape is `TARGET_ROOT=…` env var
  only. See ROADMAP M20 for the rejected alternative.
- **Don't** loop the wizard on missing `wizard_completed_at` if a primary is
  already set — that's the explicit-skip case (user set primary in Settings
  before completing wizard). The two-way AND in the gate handles it.
- **Don't** pre-set primary or preset for the user. The wizard's whole point
  is informed consent; auto-picking defeats it.
- **Don't** make `wizard_completed_at` gated. The `dry_run` gating exists
  because flipping it bypasses safety; flipping `wizard_completed_at` just
  hides the wizard. A user who manually flips it has explicitly opted out;
  that's their choice.

## Out of scope for M20

These are Phase 2 / future milestones, not this wizard:

- Multi-`target_root` switching from inside the app.
- Drag-to-reorder path priority.
- Custom preset editor (rule-by-rule).
- Re-running the wizard from Settings (deferred until a real user asks).
