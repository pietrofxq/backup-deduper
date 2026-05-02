# 0010 — Web app does not import server zod schemas

**Status:** Accepted
**Date:** 2024-08
**Touches:** [web/src/lib/apiClient.ts](../../web/src/lib/apiClient.ts), [tests/contract/api.test.ts](../../tests/contract/api.test.ts)

## Context

The server validates request and response bodies with zod
([0009-zod-end-to-end.md](0009-zod-end-to-end.md)). The web app makes
typed `fetch` calls and renders the responses.

The "obvious" choice is to share the zod schemas: import the server's
`DryRunReport` schema in `web/src/lib/apiClient.ts`, infer the type, no
duplication.

That fails for two reasons:

1. **Server-only deps come along for the ride.** Importing a schema from
   `src/server/schemas.ts` pulls in a transitive graph that ends at
   `drizzle-orm` and `better-sqlite3`. The Vite bundle balloons; the
   build complains about Node-only modules; the SPA accidentally bundles
   the DB driver.
2. **Two tsconfigs, two output targets.** The server is Node ESM; the web
   is browser ESM with Vite's bundler. The compiler flags drift, and
   deep imports across the boundary create circular path dependencies
   that break IDE-level inference.

## Decision

The web app **redeclares** response shapes as plain TypeScript interfaces
in [web/src/lib/apiClient.ts](../../web/src/lib/apiClient.ts).

The single source of truth for the wire format is the contract test
([tests/contract/api.test.ts](../../tests/contract/api.test.ts)) — it
boots the server in-process via Fastify's `.inject()`, hits every route,
and asserts both shape and DB side-effects. If the server schema changes,
the contract test fails; if the apiClient interface drifts from the
server, the apiClient's tests
([web/src/lib/__tests__/apiClient.test.ts](../../web/src/lib/__tests__/apiClient.test.ts))
catch it.

## Consequences

Better:

- Web bundle stays small. No accidental DB driver in the SPA.
- The server-side tsconfig and the web-side tsconfig stay independent.
- The contract test is the canonical wire spec — read once when adding a
  feature, not twice (schema *and* interface).

Worse:

- Two declarations to keep in sync per route. Drift is possible.
- A reviewer adding a field has to remember to add it in both places.

## Mitigations against drift

- The contract test is comprehensive enough that any new field on the
  server side fails the test if the test isn't updated.
- The apiClient declares interfaces *next to* the function that uses
  them so you can't add a method without thinking about its shape.
- Code review's `agent-review` and `copilot-review` both flag bare-string
  endpoint URLs that don't match the apiClient's known set.

## When to revisit

If the duplication count goes above ~30 routes or becomes the source of
production bugs, the right next step is **not** "share the zod schemas
directly". It's "generate a TS-only `.d.ts` from the zod schemas via a
build step, and import the `.d.ts` from the web app". That keeps the
runtime split (Vite never sees zod) while killing the duplication.
