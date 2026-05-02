# 0009 — One zod schema per route, validating both request and response

**Status:** Accepted
**Date:** 2024-04
**Touches:** [src/server/](../../src/server/), all route files; [src/server/schemas.ts](../../src/server/schemas.ts)

## Context

REST routes need:

- Input validation (don't let a malformed body crash the handler).
- Output validation (don't accidentally leak internal column names or
  break the SPA when a column is renamed).
- Type inference for the handler (we want `req.body` to be typed without
  hand-writing the type next to the schema).

The Fastify ecosystem supports this via `fastify-type-provider-zod`. Each
route declares an inline `schema` block:

```ts
app.post(
  '/scans',
  {
    schema: {
      body: StartScanBody,
      response: {
        200: ScanStartResponse,
        400: ScanGateError,
        // …
      },
    },
  },
  async (req, reply) => { /* req.body is typed */ },
);
```

## Decision

Every route uses zod for **both** request and response validation:

- Request body, query, and params live next to the route (they're
  route-specific).
- Response shapes live in `src/server/schemas.ts` (they're shared across
  contract tests and other routes).

Internal DB rows pass through these schemas, not through `JSON.stringify`,
so a rename in the `file` table doesn't accidentally leak through the
wire.

## Consequences

Better:

- One source of truth for the wire shape per route. The contract test
  asserts the schema; the handler can't drift.
- Type inference: `req.body.presetName` is `string | undefined`,
  inferred.
- Internal column names are explicitly mapped in the response schema —
  e.g. `file.collection_id` becomes `collectionId` if we want, and the
  schema expresses the mapping.

Worse:

- Adding a route is more verbose: write a body schema, write a response
  schema, register it.
- The web app deliberately does **not** import these schemas (see
  [0010-web-types-not-shared.md](0010-web-types-not-shared.md)). That
  means the response shape is duplicated as plain TS interfaces in the
  apiClient.

## Conventions

- Inline body/query/params schemas in the route file. Simple, route-local.
- Reuse a response schema from `schemas.ts` if more than one route returns
  the same shape (currently `RunRow`, `QuarantineActionRow`, etc.).
- Use `z.coerce.number()` for query-string params that should be ints (the
  raw query string is always a string).
- Use `.strict()` on patch bodies that should reject unknown keys (e.g.
  `PUT /api/config` to fence gated keys).
