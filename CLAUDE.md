# Daintree

Electron IDE for orchestrating AI coding agents — many agent terminals running in parallel across git worktrees, with fleet broadcasting, a worktree dashboard, context injection, and an MCP control surface. The agent roster lives in `shared/config/agents/` + `shared/config/agentRegistry.ts`. Product, repo, and config dir are all "Daintree" (`daintreehq/daintree`, `.daintree/`).

**Stack:** Electron 42 (Chromium 148), React 19 + React Compiler, Vite 8, TypeScript 6, Tailwind CSS v4, Zustand 5, node-pty, simple-git, better-sqlite3 + drizzle, @xterm/xterm 6.1 beta, Node 22 (`.nvmrc`). Exact pins in `package.json`. Research against these exact versions — older docs often don't apply.

## Commands

```bash
npm run dev                # Main + Renderer (Vite)
npm test -- <path>         # the ONLY way to run unit tests locally: the files you changed
npm run typecheck:changed  # only the TS projects your branch touches
npm run check              # typecheck + codegen/guard checks + lint and e2e-wait ratchets + format:check
npm run build              # production build
npm run rebuild            # native-module errors after an install
```

Typecheck runs on the TypeScript 7 native compiler. Use `npm run typecheck` or `typecheck:changed`, never a bare `tsc -b` (it emits build artifacts and phantom TS6305s). `npm install` for dev, `npm ci` only in CI.

## Architecture

- **Main (`electron/`)** — node-pty, git, OS access. Services in `services/`, IPC handlers by domain in `ipc/handlers/`, windowing in `window/`. Utility subprocesses with crash recovery: `pty-host/`, `workspace-host/`, `watchdog-host*`, `plugin-dev-worker*`.
- **Renderer (`src/`)** — React UI. Reaches Main **only** via `window.electron`; never import from `electron/`. Homes: actions → `services/actions/definitions/`, panels → `panels/<kind>/`, stores → `store/`, hooks → `hooks/`, IPC clients → `clients/`.
- **Shared (`shared/`)** — cross-process only: types (incl. `ipc/`), registries and config, the theme system.

Each project gets its own `WebContentsView` and V8 context, so renderer state is **per project view**, not global. `ActionService` is the typed dispatch layer behind menus, keybindings and context menus, and its manifest is also the local MCP server's tool surface, so action metadata is a public contract for external agents.

Path-scoped rules in `.claude/rules/` load the detail for stores and persistence, plugins and panels, agent integration, IPC, actions/MCP, design, tests, generated files and ratchets, and version traps when you open those files.

## Definition of done

1. **Never run the full unit suite locally** (bare `npm test` / `npx vitest run`: 15-20 minutes of a locked-up machine) — not mid-work, not before a commit or PR, not because a skill says to. CI runs it in 6 shards and `ci-ok` is the gate. Locally, run only the tests covering your change, plus typecheck and lint; fix anything else from the CI log.
2. **Never decide to run E2E yourself.** Run only the spec or bucket the user names, when they ask.
3. Run `npm run check` for anything touching types, IPC, keybindings, plugin manifests, or lint-visible code. Otherwise scale verification to the change.
4. Report the commands actually run and their real results, trusting exit codes over summaries: `prettier` prints "All files formatted correctly" while exiting 1, and `rtk` reports "No errors found" while `tsc` fails (use `rtk proxy` for anything you'll make a claim about).
5. Never weaken a test, suppress a warning, hand-edit generated output or a ratchet baseline, or widen a baseline to make a change pass. Regenerate from the source.

## Repository workflow

- **Nothing in the repo root** except project config and top-level docs: no previews, scratch scripts, logs or reports, tracked or not. Temporary output goes in `.tmp/` (gitignored).
- **Gitflow:** PRs target `develop`, never `main`.
- **Never operate in the main worktree** when a session has its own; other trees have live sessions in them.
- `.daintree/recipes/*.json` are intentionally tracked: never remove or gitignore them. `.planning/` is private, gitignored, and rejected by the pre-commit hook.
- Use the `gh` CLI for all GitHub operations; plain HTTP fetches fail on auth.
- Skip issues labelled `human-review` (not solvable autonomously) and `monitoring` (blocked on an external event).
- Daintree's worktree setup links a new worktree's `node_modules` to the main checkout's and fails when that shared install doesn't match the worktree's `package-lock.json`; the fix is `npm ci` in the main checkout, never inside a worktree (it wipes the shared install). A worktree made outside Daintree needs `DAINTREE_PROJECT_ROOT=<main checkout> node scripts/link-shared-node-modules.mjs`, and every worktree needs a build before the app starts. Details and per-machine approval: `docs/development.md#worktrees`.
- `npm run fix` reformats repo-wide; fix your own files by hand when a PR must stay scoped.
- Rebuilding while the app is running poisons its lazy chunks: the single-instance lock refocuses the old window and its imports 404.

## Product invariants

- **Never modify user-owned agent config** (`~/.claude/`, `~/.gemini/`, `~/.codex/`, user hooks, CLAUDE.md/AGENTS.md in users' projects), not even additive CLI injection like `--settings`. Use passive observation instead. The two narrow exceptions are in `.claude/rules/agent-integration.md`.
- **Surface observations, not interpretations.** Agent state comes from passive PTY heuristics and is frequently wrong; MCP tools and UI expose what we saw, never what we concluded.
- **Vanilla Daintree pays nothing for plugins:** a capability with no consumer costs nothing at runtime.
- **Never commit credentials, tokens, or customer data**, and never log terminal contents or prompt bodies on paths that leave the machine.

## Style

Minimal comments, no decorative headers; comments explain _why_, never _what_. Markdown is never hard-wrapped: every paragraph, list item and table row is one physical line. Before writing UI, check `src/components/ui/`; the design rules load with UI files.

`docs/README.md` indexes all docs; `docs/feature-curation.md` is the rubric for what _not_ to build.
