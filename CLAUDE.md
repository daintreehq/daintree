# Daintree

Electron IDE for orchestrating AI coding agents — many agent terminals running in parallel across git worktrees, with fleet broadcasting, a worktree dashboard, context injection, and an MCP control surface. 18 agent CLIs are supported; the roster lives in `shared/config/agents/` + `shared/config/agentRegistry.ts`. Product, repo, and config dir are all "Daintree" (`daintreehq/daintree`, `.daintree/`).

**Stack:** Electron 42 (Chromium 148), React 19 + React Compiler, Vite 8, TypeScript 6, Tailwind CSS v4, Zustand 5, node-pty, simple-git, better-sqlite3 + drizzle, @xterm/xterm 6.1 beta. Node 22.23.2 (`.nvmrc`, guarded by `check:node-version`). Exact pins in `package.json`.

**Research against our exact versions** — never assume older docs apply. Known traps: Electron 42 (unsigned macOS notifications silently emit `failed`; `Session.clearStorageData` drops `quotas`), xterm 6.x (canvas renderer, `windowsMode` and `fastScrollModifier` all removed; new event system), Tailwind v4 (`color-mix()` alpha semantics).

## Commands

```bash
npm run dev            # Main + Renderer (Vite)
npm test               # vitest (CI runs this in 4 shards)
npm test -- <path>     # narrowest useful test while iterating
npm run check          # typecheck + 12 codegen/guard checks + lint ratchet + format:check
npm run fix            # prettier --write + eslint --fix
npm run build          # production build
npm run rebuild        # rebuild native modules after an install failure
```

`npm install` for dev, `npm ci` for CI; `postinstall` rebuilds `node-pty` for Electron. Native-module errors → `npm run rebuild`.

Use `npm run typecheck`, never a bare `tsc -b` — the project-reference graph emits build artifacts and phantom TS6305s outside the wrapper.

## Architecture

- **Main (`electron/`)** — node-pty, git, OS access. Services in `services/`, IPC handlers by domain in `ipc/handlers/`, windowing in `window/`. Utility subprocesses with crash recovery: `pty-host/`, `workspace-host/`, `watchdog-host*`, `plugin-dev-worker*`.
- **Renderer (`src/`)** — React UI. Reaches Main **only** via `window.electron`; never import from `electron/` directly. Homes: actions → `services/actions/definitions/`, panels → `panels/<kind>/`, stores → `store/`, hooks → `hooks/`, IPC clients → `clients/`.
- **Shared (`shared/`)** — cross-process only: types (incl. `ipc/`), registries and config, the theme system. Nothing renderer- or main-exclusive belongs here.

Each project gets its own `WebContentsView` and V8 context via `ProjectViewManager`, with LRU eviction under memory pressure — so renderer state is **per project view**, not global. Per-window services live in `WindowContext.services`; PtyClient and WorkspaceClient are shared globals.

**Cross-store reads go through `src/store/storeAccessors.ts`** — never import a partner store at module eval (TDZ; see `docs/architecture/store-init-order.md`). 116 store creation sites across 115 files — 114 app-global `create()`, plus two `zustand/vanilla`: `shortcutHintStore` (module singleton) and `createWorktreeStore`, the sole per-project-view factory.

**Durable state spans two engines with separate migrations:** better-sqlite3 + drizzle (`npm run db:generate`) and electron-store JSON (`electron/store.ts`).

`ActionService` (`src/services/ActionService.ts`) is the typed dispatch layer behind menus, keybindings, context menus, and agent automation — and the same manifest is the tool surface of the local MCP server (`electron/services/mcp-server/`), so an action's metadata is a public contract for external agents.

Panels are a 7-member union in `shared/types/panel.ts` (`terminal`, `browser`, `dev-preview`, `review`, `file`, `file-browser`, `diff`) with per-kind modules in `src/panels/<kind>/` and the registry in `shared/config/panelKindRegistry.ts`.

Plugins are manifest-driven, activate out-of-process in unsandboxed `utilityProcess.fork` workers (builtins are the exception and load in-process), and contribute actions, panels, agents, toolbar buttons, and forge providers under capability + consent gating. GitHub ships as a builtin forge plugin (`plugins/builtin/github`) so the host stays forge-neutral. Author SDK = the `packages/*` npm workspace (`npm run packages:build`).

## Generated code and ratchets

**Never hand-edit generated output.** Regenerate from the source instead:

| Generated                        | Regenerate with                                       |
| -------------------------------- | ----------------------------------------------------- |
| `shared/types/ipc/generated*.ts` | `npm run codegen:ipc && npm run codegen:ipc-renderer` |
| `docs/keyboard-shortcuts.md`     | `npm run codegen:keybindings`                         |
| drizzle migrations               | `npm run db:generate`                                 |
| help prompts                     | `npm run build:help`                                  |

Nine ratchet baselines live in `scripts/baselines/` — **regenerate the baseline, never hand-edit the JSON**: `lint:ratchet` (eslint warnings), `compiler-budget` (React Compiler bailouts), `import-budget`, `renderer-import-budget`, `renderer-bundle-budget`, `first-render-chunk-budget`, `test-ratio`, `check:ipc-handwritten`, `theme:text-ramp`. Six have matching `*:check`/`*:update` scripts; three do not — update `lint:ratchet` with `-- --update`, `check:ipc-handwritten` via `ipc-handwritten:update`, and `theme:text-ramp` with `-- --check` / `-- --plan` (`--plan` rewrites the manifest).

Only `lint:ratchet` and `check:ipc-handwritten` run inside `npm run check`; the budget scripts are deliberately out of CI pre-1.0. The lint ratchet gates **per-rule as well as in total**, and a rule vanishing from live output is a hard failure — so you cannot silence a rule in config to get under the gate.

React Compiler is enabled (`babel-plugin-react-compiler`, `target: "19"`). A bailout is silent at runtime but reddens `compiler-budget`; `docs/development.md` has the diagnosis tooling.

## Definition of done

1. Iterate with the narrowest useful test, then run the **full** `npm test` — scoped runs have repeatedly missed failures that cost a CI round trip.
2. Run `npm run check` for anything touching types, IPC, keybindings, plugin manifests, or lint-visible code.
3. Scale verification to the change. A small edit does not need build + E2E + full check stacked on top.
4. Report the commands actually run and their real results. `prettier` prints "All files formatted correctly" while exiting 1 — trust the exit code, not the summary.
5. Never weaken a test, suppress a warning, or widen a baseline to make a change pass.

CI on PRs: `check` + vitest (4 shards) + build + smoke, Ubuntu only, no E2E. `ci-ok` is the sole required check.

**E2E is expensive and locks up the machine — never decide to run it yourself.** Run only the spec or bucket the user names, and only when they ask. Full cross-platform validation goes through the `stabilize` workflow (`.agents/skills/stabilize/`), never a local sweep and never as part of a merge. E2E runs against the built app, so a stale or failed `npm run build:e2e` silently tests the old bundle.

## Repository workflow

- **Gitflow** — all PRs target `develop`, never `main` (release merges only).
- **Never operate in the main worktree** when a session has its own; other trees have live sessions in them.
- Use the `gh` CLI for all GitHub operations — plain HTTP fetches fail on auth.
- `.daintree/recipes/*.json` are intentionally tracked. Never remove or gitignore them.
- `.planning/` is gitignored and the pre-commit hook rejects it.
- Skip issues labelled **`human-review`** (not solvable autonomously; 10-20x cost) and **`monitoring`** (blocked on an external event — checkable, not workable; sweep monthly via the `monitoring-sweep` skill).
- The in-app assistant is a **separate repo**, `daintreehq/assistant`. Its host-embedding contract lives there in `DAINTREE_HOST.md`; a change to that contract belongs in both repos.
- `AGENTS.md` and `GEMINI.md` point here. Update this file, not those.

## Product invariants

**Never modify user-owned agent config** — `~/.claude/`, `~/.gemini/`, `~/.codex/`, user hooks, or CLAUDE.md/AGENTS.md files in the user's own projects — not even additive CLI injection like `--settings`. If a capability needs it, the capability is out of scope; use passive observation instead (output parsing, OSC titles, process tree, `AgentPatternDetector`-style regex). Precedent #4100.

**Surface observations, not interpretations.** Agent state comes from passive PTY output heuristics (`AgentStateService`, FSM in `shared/utils/agentFsm.ts`) and is frequently wrong; MCP tools and UI should expose what we saw, never what we concluded from it. `running` is a runtime status, not an agent state.

**Never commit credentials, tokens, or customer data**, and never log terminal contents or prompt bodies on paths that leave the machine.

## Design and UX

Daintree has a strict, heavily litigated visual and interaction contract. The rules load automatically when you touch matching files: `.claude/rules/design-system.md` (colour vocabulary, accent restraint, motion, loading gates, icons), `.claude/rules/user-signals.md` (microcopy, notify routing, runtime-signal tiers, destructive-action tiers), `.claude/rules/overlay-focus.md` (tooltip and focus restoration on overlay close).

Two things worth knowing before you write any UI: check `src/components/ui/` before hand-rolling a surface, and accent colour is at most **one** load-bearing signal per focus region — in doubt, no accent.

Themes are their own discipline — use the `daintree-theme-creator` skill rather than editing palettes by hand.

## Code and prose style

Minimal comments, no decorative headers, high signal-to-noise. Comments explain _why_, never _what_.

**Markdown is never hard-wrapped** — every paragraph, list item, and table row is one physical line; soft wrap is the renderer's job. Applies to all `.md`. Code blocks and ASCII diagrams keep their internal breaks.

## Gotchas

- `npm run fix` reformats and auto-fixes **repo-wide**, sweeping files you never touched. Apply fixes to your own files by hand when a PR needs to stay scoped.
- A fresh worktree needs its `node_modules` symlink and a build before the app will start — "app won't launch" there is almost never a bug. Never run `npm ci` inside a worktree; it wipes the shared install.
- Rebuilding while the app is running poisons its lazy chunks — the single-instance lock refocuses the old window and its imports 404 on hashes the build just replaced.
- `rtk` summaries lie: it reports "No errors found" while `tsc` exits non-zero, and it silently truncates `git log`. Use `rtk proxy` for anything you'll make a claim about.
- No `@testing-library/jest-dom` in this repo — `toBeInTheDocument` throws "Invalid Chai property". Use plain DOM reads.
- `vite` is pinned `~8.0.14` on purpose: 8.1.x changes chunk faceting so `LazyMotion` never initialises and boot dies. Don't bump it casually.

## Further reference

`docs/README.md` is the full index. Most-used: `docs/development.md` (IPC patterns, debugging, compiler-bailout tooling), `docs/architecture/` (actions, MCP server, state, persistence, terminal lifecycle, notifications, destructive safeguards, crash recovery, process/window model), `docs/themes/`, `docs/plugins/`, `docs/e2e-testing.md`, `docs/feature-curation.md` (the rubric for what _not_ to build).
