# Adding an API route

Step-by-step. Assumes you've already read [api.md](../api.md) and
[decisions/0009-zod-end-to-end.md](../decisions/0009-zod-end-to-end.md).

## Inventory

When you add a route, you touch:

| concern | file |
|---------|------|
| Route definition | new or existing file under [src/server/routes/](../../src/server/routes/) |
| Route registration | [src/server/routes/index.ts](../../src/server/routes/index.ts) |
| Response zod schema | [src/server/schemas.ts](../../src/server/schemas.ts) (if reusable) |
| Business logic | a new function in `src/orchestrator/` or wherever fits |
| DB query | [src/db/queries.ts](../../src/db/queries.ts) (never inline) |
| Contract test | [tests/contract/api.test.ts](../../tests/contract/api.test.ts) |
| Web client method | [web/src/lib/apiClient.ts](../../web/src/lib/apiClient.ts) |
| Web client query key | [web/src/lib/queryKeys.ts](../../web/src/lib/queryKeys.ts) |
| Web component | depends on the page |
| Docs | [api.md](../api.md), this workflow |

## Step 1 — Define the route

Pick the right routes file, or create a new one if the resource is new.
Wire it up via `registerRoutes` in
[src/server/routes/index.ts](../../src/server/routes/index.ts).

Skeleton:

```ts
// src/server/routes/widgets.ts
import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import type { ZodApp } from '../types.js';
import { listWidgets, createWidget } from '../../db/queries.js';
import { ErrorResponse } from '../schemas.js';

const ListQuery = z.object({
  q: z.string().optional(),
});

const CreateBody = z.object({
  name: z.string().min(1),
});

const Widget = z.object({
  id: z.number(),
  name: z.string(),
});

export async function registerWidgetRoutes(app: ZodApp, deps: ServerDeps) {
  app.get(
    '/widgets',
    {
      schema: {
        querystring: ListQuery,
        response: { 200: z.array(Widget) },
      },
    },
    async (req) => listWidgets(deps.db, req.query.q),
  );

  app.post(
    '/widgets',
    {
      schema: {
        body: CreateBody,
        response: { 200: Widget, 400: ErrorResponse },
      },
    },
    async (req, reply) => {
      try {
        return createWidget(deps.db, req.body.name);
      } catch (err) {
        if (err instanceof DuplicateNameError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
```

Then in `index.ts`:

```ts
import { registerWidgetRoutes } from './widgets.js';
// …
await registerWidgetRoutes(typed, deps);
```

## Step 2 — Add the DB query

Add to [src/db/queries.ts](../../src/db/queries.ts). Use Drizzle (`db.q.<table>.…`)
unless raw SQL is necessary.

```ts
export function listWidgets(db: Db, q?: string): { id: number; name: string }[] {
  let query = db.q.select().from(widget);
  if (q) query = query.where(like(widget.name, `%${q}%`));
  return query.all();
}
```

If raw SQL is needed (e.g. a complex pagination query, a partial index
lookup, or an `INSERT ON CONFLICT`), use `db.client.prepare(...).all()`
or `.run()` with parameterized statements. **Never** string-concatenate
user input.

## Step 3 — Add a contract test

[tests/contract/api.test.ts](../../tests/contract/api.test.ts) is the
single source of truth for the wire shape. Add a test before the route
handler does anything irreversible:

```ts
test('GET /api/widgets returns shape', async () => {
  const { app } = await bootTestServer();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/widgets' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
  } finally {
    await app.close();
  }
});
```

The test runs Fastify in-process via `.inject()` — no socket, no
Playwright. See the file for the existing patterns (`bootTestServer`,
fixtures, etc.).

## Step 4 — Mutex if destructive

If the route does anything destructive (renames, deletes, modifies disk
state), wrap the body in `withMutationLock`:

```ts
import { withMutationLock } from '../../orchestrator/mutex.js';

app.post(
  '/widgets/:id/destroy',
  { schema: { /* … */ } },
  async (req) =>
    withMutationLock(() => destroyWidget(deps.db, deps.targetRoot, req.params.id)),
);
```

This serializes destructive ops across all routes.

## Step 5 — SSE if long-running

If the route runs for >1 second, emit progress on the event bus:

```ts
deps.events?.publish('phase', runId, { phase: 'starting' });
// … do work …
deps.events?.publish('phase', runId, { phase: 'done' });
```

The route stays synchronous (it's still `await someJob`), and the SSE
channel is the **visualization** layer — see how `/api/scans` uses both
in [src/server/routes/scans.ts](../../src/server/routes/scans.ts).

## Step 6 — Update the apiClient

Add a method to [web/src/lib/apiClient.ts](../../web/src/lib/apiClient.ts):

```ts
export interface Widget {
  id: number;
  name: string;
}

// in the createApiClient() factory:
listWidgets: (q?: string) =>
  request<Widget[]>(`/api/widgets${q ? `?q=${encodeURIComponent(q)}` : ''}`),
createWidget: (body: { name: string }) =>
  request<Widget>('/api/widgets', { method: 'POST', body }),
```

Add a query key in [web/src/lib/queryKeys.ts](../../web/src/lib/queryKeys.ts):

```ts
widgets: (q?: string) => ['widgets', q ?? null] as const,
```

Add tests in
[web/src/lib/__tests__/apiClient.test.ts](../../web/src/lib/__tests__/apiClient.test.ts).

## Step 7 — Update [api.md](../api.md)

Add the route to the index table, document the request/response shape,
note any new error envelopes.

## Don't forget

- **CORS.** New routes inherit the localhost-only allowlist
  ([decisions/0007-localhost-cors.md](../decisions/0007-localhost-cors.md)).
  Don't loosen it without an ADR.
- **Gated config.** If your route changes a config key, gate it the same
  way `dry_run` is gated — see [config.md](../config.md).
- **Audit log.** If the route performs a state change worth recording,
  call `appendAudit(targetRoot, '<event>', {...})`.
- **Same-origin SPA fallback.** Routes under `/api/*` keep returning JSON
  on 404; everything else falls back to `index.html`. If you're adding a
  *non*-`/api` route, think hard — almost everything should be under `/api`.
