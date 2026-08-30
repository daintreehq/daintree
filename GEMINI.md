# Daintree — agent instructions

The working contract for this repository lives in **[`CLAUDE.md`](./CLAUDE.md)**. Read it first.

Path-scoped rules live in `.claude/rules/` and apply when you touch matching files:

| Rule | Applies to |
| --- | --- |
| `design-system.md` | `src/**/*.tsx`, `src/**/*.css` — colour vocabulary, accent restraint, motion, loading gates, icons |
| `user-signals.md` | `src/**/*.ts(x)` — microcopy, notify() routing, runtime-signal tiers, destructive-action tiers |
| `overlay-focus.md` | `src/components/**` — tooltip and focus restoration on overlay close |
| `testing.md` | tests and `e2e/**` — vitest and Playwright conventions, what CI runs |
| `ipc-channels.md` | `electron/ipc/**`, `electron/preload.cts` — adding a channel |
| `actions-and-mcp.md` | `src/services/actions/**`, `electron/services/mcp-server/**` |
| `perf-benchmarks.md` | `scripts/perf/**` |

Longer-form reference is indexed in `docs/README.md`.

This file is deliberately a pointer. It previously duplicated `CLAUDE.md` and drifted six rules behind it — keep the single source of truth in `CLAUDE.md` rather than re-forking the content here.
