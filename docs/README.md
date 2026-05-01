# Documentation index

This directory is the source-of-truth context map for AI agents (and humans)
extending `safe-dedupe`. Every doc here is intended to be readable
**standalone** — no need to load every file to be useful on a single task.

If you are an AI agent landing here for the first time, you should also have
already read:

- [`AGENTS.md`](../AGENTS.md) — hard rules, learned-the-hard-way directives.
- [`PLAN.md`](../PLAN.md) — the locked design.
- [`ROADMAP.md`](../ROADMAP.md) — milestone status, backlog, deferred items.

Read those first. Read this set when you need a *factual* reference: where a
function lives, what a column means, what wire shape a route returns.

## Where to start by task type

| Task | Open these |
|------|------------|
| Add a new HTTP route | [api.md](api.md), [workflows/adding-an-api-route.md](workflows/adding-an-api-route.md), [conventions.md](conventions.md) |
| Add a new mover/destructive op | [safety-model.md](safety-model.md), [workflows/adding-a-mover-op.md](workflows/adding-a-mover-op.md), [`AGENTS.md`](../AGENTS.md) §1, §3, §5 |
| Touch the schema | [schema.md](schema.md), [workflows/changing-the-schema.md](workflows/changing-the-schema.md) |
| Add or modify a preset | [classifier.md](classifier.md), [workflows/adding-a-preset.md](workflows/adding-a-preset.md) |
| Change classifier rule precedence | [classifier.md](classifier.md), [safety-model.md](safety-model.md) |
| Touch config keys | [config.md](config.md) |
| Investigate a Windows/macOS bug | [conventions.md](conventions.md) §cross-platform |
| Pick the "why" behind a non-obvious choice | [decisions/](decisions/) |
| Audit what's broken or deferred | [known-gaps.md](known-gaps.md), [`ROADMAP.md`](../ROADMAP.md) |

## Structure

```
docs/
├── README.md                 ← you are here
├── architecture.md           system/process model + module map + data flow
├── safety-model.md           the 8 invariants, fences, two-phase commit
├── schema.md                 every table + column + index, with rationale
├── api.md                    HTTP routes, SSE wire format, error envelopes
├── classifier.md             rule precedence, preset/whitelist semantics
├── config.md                 config keys, defaults, gated keys
├── filesystem-layout.md      on-disk layout under <target_root>
├── conventions.md            code style, error handling, testing, cross-platform
├── known-gaps.md             doc/code drift + deferred concerns not yet in ROADMAP
├── decisions/                ADRs — read before reversing a choice
│   ├── README.md             ADR index
│   └── 0001…N.md
└── workflows/                step-by-step extension guides
    ├── adding-an-api-route.md
    ├── adding-a-preset.md
    ├── adding-a-mover-op.md
    └── changing-the-schema.md
```

## Doc maintenance contract

Every doc in this directory should reference code by file path (and where
useful, by `file.ts:LINE`). When the code moves, the doc is updated **in the
same diff**. AGENTS.md rule #8 ("doc/code drift is a real bug class") applies
here too — the bar is the same.

When you change behavior in a way that contradicts something written here,
either fix the doc in the same commit or, if the change is intentional and
larger than a one-line update, add an ADR under `decisions/` explaining the
new direction.
