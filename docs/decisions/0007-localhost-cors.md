# 0007 — Localhost-only CORS allowlist

**Status:** Accepted
**Date:** 2024-04
**Touches:** [src/server/index.ts:23–28](../../src/server/index.ts)

## Context

In dev, the Vite server runs on `:5173` and Fastify on `:7777`. The SPA's
`fetch('/api/...')` calls land cross-origin and need CORS. In prod, the
SPA is served by Fastify same-origin and CORS is irrelevant.

The naïve fix is `origin: '*'`. That's catastrophic here: the tool
mediates destructive moves on user data — any web page the user visits
could `fetch('http://localhost:7777/api/quarantine/run')` if we allowed
arbitrary origins.

## Decision

Allowlist exactly four origins:

```
http://localhost:5173
http://127.0.0.1:5173
http://localhost:4173       (Vite preview)
http://127.0.0.1:4173
```

`credentials: false`. Methods: GET / PUT / POST / DELETE / OPTIONS.

In production (`web/dist` served by Fastify) the SPA is same-origin so
the allowlist never matches and CORS is a no-op.

## Consequences

Better:

- A malicious page on the open internet cannot trigger any of our
  routes — `Origin` will be `https://evil.example`, not on the allowlist,
  fetch fails before our handler runs.
- Defense in depth: even if the dry-run gate or sanity guard had a bug,
  the attack surface is bounded by the allowlist.

Worse:

- Developers running the dev server on a non-default port have to
  amend the allowlist (or use the prod build for testing).
- Reverse-proxying the dev server to a custom origin needs an explicit
  allowlist entry.

## Alternatives considered

- **`origin: true` (reflect any origin)** — catastrophic, see above.
- **`origin: '*'`** — same.
- **No CORS** (rely on browser same-origin enforcement) — works in prod
  but breaks Vite-driven dev. Rejected.
- **CSRF token** — overkill; no cookies, no session. The localhost
  binding (`127.0.0.1`) plus origin allowlist is sufficient.

## Note for future revisits

If we ever need to expose the API to a non-browser client (a CLI script,
an external dashboard), do **not** widen the CORS allowlist. Add an
explicit token-auth path for that client; CORS is for browser callers
only, and the tool's threat model is rooted in browser-bound attackers.
