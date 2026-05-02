# 0001 — Local web UI in browser; no Electron, no Playwright in CI

**Status:** Accepted
**Date:** 2024-02
**Touches:** the entire frontend, CI test matrix

## Context

The tool needs a UI for a single human reviewing thousands of files
before destructive moves happen. Three obvious candidates:

1. Electron app — bundled binary, native chrome.
2. Tauri/wails — smaller binaries, system webview.
3. Local web server + browser tab — no bundling, "open localhost:7777".

We also need to test the UI. The two candidates are headless browser
(Playwright/Cypress) or component-only (React Testing Library + vitest).

## Decision

- Ship a Vite/React SPA served by Fastify at `/`. The user opens
  `localhost:7777` in their existing browser.
- **No Electron.** The bundling, signing, and native-process management
  are not worth the win for a tool the user runs against their own data.
- **No Playwright in CI for v1.** Component tests cover React surface;
  the safety-critical surface (mover, classifier, SQL) is 100% testable
  through unit + integration + contract + property layers without a
  browser. ROADMAP M12 adds **one** Playwright test for the
  type-to-confirm flow specifically.

## Consequences

Better:

- Zero install footprint beyond `node_modules/`. Cross-platform binary
  story is just "Node 20 + the repo".
- Test matrix runs in seconds across three OSes. CI < 10 min per OS.
- The user's own browser handles persistence, password manager, dev
  tools, accessibility settings.

Worse:

- We can't intercept OS-level events (file watchers, system tray, push
  notifications). The model is "user opens the tab, presses Scan, watches
  progress."
- We have to run a port (`7777` by default) — collisions on busy
  developer machines.
- A genuinely-malicious local web page could in theory CSRF us, so the
  CORS allowlist is localhost-only and we don't accept credentials. See
  [0007-localhost-cors.md](0007-localhost-cors.md).

## Alternatives considered

- **Electron**: rejected — three problems for one solution. Bundling per
  OS, native menu integration we don't need, and a wholly separate
  test/release pipeline.
- **Tauri**: rejected for v1 — Rust toolchain in CI; small enough we
  could revisit if "single .exe" becomes a hard requirement for v2.
- **CLI-only**: rejected — review queue and dry-run report are
  fundamentally tabular and visual; the type-to-confirm gate is
  better-modeled in a UI than a TUI.
- **Headless browser E2E**: rejected for v1 — high fixed cost, brittle
  in CI. The flow it actually catches (the type-to-confirm dialog) gets
  a single targeted test in M12.
