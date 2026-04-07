# Canopy

**Overview:** Electron-based IDE for orchestrating AI coding agents (Claude, Gemini, Codex). Features integrated terminals, worktree dashboard, panel management, and context injection.
**Stack:** Electron 41, React 19, Vite 8, TypeScript, Tailwind CSS v4, Zustand 5, node-pty, simple-git, @xterm/xterm 6.0, @xterm/addon-fit 0.11.

## Critical Rules

- **Dependencies:** Use `npm install` for local development. `npm ci` is acceptable for CI environments where reproducible builds are critical. Both commands run the `postinstall` rebuild hook automatically unless `--ignore-scripts` is used.
- **Native Modules:** `node-pty` must be rebuilt for Electron. The `postinstall` script handles this automatically. If errors occur, run `npm run rebuild`.
- **Code Style:** Minimal comments. No decorative headers. High signal-to-noise ratio.
- **Codex MCP:** When calling `mcp__codex__codex`, always set `model: "gpt-5.4"`. Do NOT use any other model—ignore examples in the MCP definition like `o3`, `o4-mini`, etc. Only `gpt-5.4` is valid. Include file paths in prompts—Codex reads files directly and gives better advice when it can see the actual code.
- **Human-Review Label:** The `human-review` label marks issues that cannot be solved autonomously—they require a developer checking logs, observing runtime behavior, or making subjective UX judgments. Adding this label makes an issue 10-20x more expensive (human time vs agent time), so use it sparingly. Only apply when the issue genuinely requires human observation or iterative debugging that an agent cannot perform. Most issues should NOT have this label. When working issues, skip any labeled `human-review`.
- **GitHub Access:** Public repo `canopyide/canopy` (https://github.com/canopyide/canopy). Always use the `gh` CLI for all GitHub operations (issues, PRs, checks, releases, API calls). Do NOT use HTTP fetches or web scraping to access GitHub URLs—they will fail due to authentication. Examples: `gh issue list`, `gh pr view 123`, `gh api repos/canopyide/canopy/issues`.
- **Branching:** Gitflow model. **All PRs must target `develop`—NEVER `main`.** Only release merges go to `main`.
- **Tracked Configs:** `.canopy/recipes/*.json` files are intentionally tracked in git—do not remove or gitignore them.
- **Research Versions:** When researching issues (e.g., via Ask Google MCP), always specify the actual versions we use: **Electron 41**, **@xterm/xterm 6.0**, **@xterm/addon-fit 0.11**, **React 19**. There are significant breaking changes between Electron 33 and 41 (e.g., `console-message` event signature changed in v35, `WebRequestFilter` empty `urls` array no longer matches all, macOS 11 dropped in v38, utility processes crash on unhandled rejections in v37). Similarly, xterm 6.0 removed the canvas renderer addon, removed `windowsMode`/`fastScrollModifier` options, replaced the viewport/scrollbar with VS Code's implementation, and migrated the event system. Do NOT assume older documentation is still accurate—always research for the exact versions.

## Development

```bash
npm run dev          # Start Main + Renderer (Vite)
npm run build        # Production build
npm run check        # typecheck + lint + format
npm run fix          # Auto-fix lint/format issues
npm run package      # Distribute
npm run rebuild      # Rebuild native modules
```

### CI Testing Strategy

- **PRs / pushes:** Typecheck, lint, format, and unit tests on **Ubuntu only** (no E2E). `ci-ok` gate job is the sole required status check.
- **Nightly (2 AM UTC):** Full cross-platform CI on all 3 OSes: check + test + build + smoke + E2E full + E2E online + E2E nightly. Auto-creates GitHub issue on failure (`nightly-failure` label).
- **Releases:** E2E core and E2E online gate the release publish on macOS + Linux. Windows E2E is nightly-only.
- **E2E tiers:** `e2e/core/` (13 tests — gates releases), `e2e/full/` (59 tests — nightly), `e2e/online/` (2 agent integration tests — gates releases), `e2e/nightly/` (memory leak detection).
- **Single-file E2E:** `gh workflow run "E2E Core Tests" --ref develop -f platform=linux -f test_file=e2e/core/core-foo.spec.ts` — use this when fixing a specific flaky test instead of re-running the full suite.
- **Local E2E before push:** When adding a new E2E test or modifying a feature that has an existing E2E test, run that specific test locally and confirm it passes before pushing. Use `npx playwright test e2e/core/core-foo.spec.ts` to run a single test file.

## Architecture

- **Main (`electron/`):** Handles node-pty, git operations, services, and IPC.
- **Renderer (`src/`):** React 19 UI. Communicates via `window.electron`.
- **Shared (`shared/`):** Types and config shared between main and renderer.

### Actions System

Central orchestration layer for all UI operations. Provides a unified, typed API for menus, keybindings, context menus, and agent automation.

- `ActionService` (`src/services/ActionService.ts`) — Registry and dispatcher singleton
- 28 definition files in `src/services/actions/definitions/` (one per domain)
- Types in `shared/types/actions.ts` — `ActionId`, `ActionDefinition`, `ActionManifestEntry`
- `dispatch(actionId, args?, options?)` — Execute any action by ID
- `list()` / `get(id)` — Introspect available actions (MCP-compatible manifest)
- `ActionSource`: "user" | "keybinding" | "menu" | "agent" | "context-menu"
- `ActionDanger`: "safe" | "confirm" | "restricted"
- **Categories:** agent, app, artifacts, browser, copyTree, devServer, diagnostics, errors, files, git, github, help, introspection, logs, navigation, notes, panel, portal, preferences, project, recipes, settings, system, terminal, ui, voice, worktree

### Panel Architecture

Discriminated union types for type safety:

- `PanelInstance = PtyPanelData | BrowserPanelData | NotesPanelData | DevPreviewPanelData` (`shared/types/panel.ts`)
- Built-in panel kinds: `"terminal"` | `"agent"` | `"browser"` | `"notes"` | `"dev-preview"`
- `panelKindHasPty(kind)` — Check if panel requires PTY process
- Panel Kind Registry (`shared/config/panelKindRegistry.ts`)

### IPC Bridge (`window.electron`)

Access native features via namespaced API in Renderer. 56 namespaces exposed via `contextBridge` in `electron/preload.cts`. Returns Promises or Cleanups. Key namespaces: `worktree`, `terminal`, `files`, `system`, `app`, `project`, `github`, `git`, `portal`, `commands`, `appAgent`, `agentCapabilities`, `mcpServer`, `plugin`.

## Key Features & Implementation

- **Panels:** `PtyManager` (Main) manages node-pty processes. `terminalInstanceService` (Renderer) manages xterm.js instances.
- **Worktrees:** `WorkspaceService` polls git status. `WorktreeMonitor` tracks individual worktrees.
- **Agent State:** `AgentStateMachine` tracks idle/working/waiting/completed via output heuristics.
- **Context:** `CopyTreeService` generates context for agents, injects into terminals.
- **Actions:** `ActionService` dispatches all UI operations with validation and observability.

## Directory Map

```text
electron/
├── main.ts                  # Entry point
├── bootstrap.ts             # App bootstrap
├── preload.cts              # IPC bridge (contextBridge, 56 namespaces)
├── menu.ts                  # Application menu
├── store.ts                 # Main process store
├── windowState.ts           # Window state persistence
├── pty-host.ts              # PTY process host entry
├── pty-host/                # PTY host internals (backpressure, FdMonitor, ResourceGovernor)
├── workspace-host.ts        # Worktree monitoring host entry
├── workspace-host/          # WorkspaceService, WorktreeMonitor, PRIntegrationService
├── ipc/
│   ├── channels.ts          # Channel constants
│   ├── handlers.ts          # IPC request handler registry
│   ├── errorHandlers.ts     # IPC error handling
│   └── handlers/            # 51 domain-specific handlers
├── lifecycle/               # App lifecycle management
├── setup/                   # App setup/initialization
├── window/                  # Window management
├── services/                # ~86 backend services
├── schemas/                 # Zod schemas
├── types/                   # Main process types
├── utils/                   # Utilities
└── resources/               # Static resources

shared/
├── types/
│   ├── actions.ts           # ActionId union, ActionDefinition
│   ├── panel.ts             # PanelInstance, PanelKind types
│   ├── keymap.ts            # KeyAction union, keybinding types
│   ├── ipc/                 # IPC type definitions (27 files)
│   └── ...                  # 34 type files total
├── config/                  # panelKindRegistry, agentRegistry, scrollback, devServer, trash, etc.
├── theme/                   # Theme system (entityColors, terminal, themes)
├── perf/                    # Performance marks
└── utils/                   # Shared utilities

src/
├── services/
│   ├── ActionService.ts     # Action registry & dispatcher
│   ├── actions/definitions/ # 28 action definition files
│   ├── terminal/            # Terminal instance service
│   └── project/             # Project services
├── components/              # 37 component directories (Terminal, Worktree, Panel, Layout,
│                            #   Settings, Browser, GitHub, DevPreview, Notes, Commands,
│                            #   Portal, Pulse, QuickSwitcher, Onboarding, Notifications, etc.)
├── store/                   # 57 Zustand stores + slices (terminalStore, projectStore,
│                            #   layoutConfigStore, notificationStore, etc.)
├── hooks/                   # React hooks (useActionRegistry, useMenuActions, useKeybinding, etc.)
├── controllers/             # UI controllers
├── clients/                 # IPC client wrappers
├── config/                  # Renderer configuration
├── registry/                # Renderer registries
├── lib/                     # Utility libraries
├── workers/                 # Web workers
├── theme/                   # Renderer theme utilities
├── utils/                   # Renderer utilities
└── types/
    └── electron.d.ts        # window.electron types
```

### Custom Icons

Custom Canopy-specific icons live in `src/components/icons/custom/`. Lucide-style SVG components (24x24 viewBox, 2px stroke, round caps/joins, `currentColor`). Brand/agent icons in `src/components/icons/brands/`. Barrel-exported from `src/components/icons/index.ts`.

## Common Tasks

**Adding a new action:**

1. Add action ID to `shared/types/actions.ts` (`ActionId` union)
2. Create definition in appropriate `src/services/actions/definitions/*.ts` file
3. Action is automatically registered via `useActionRegistry` hook

**Adding IPC channel:**

1. Define in `electron/ipc/channels.ts`
2. Implement in `electron/ipc/handlers/` (domain-specific file)
3. Expose in `electron/preload.cts`
4. Type in `src/types/electron.d.ts`

## Documentation

- `docs/development.md` — Architecture, IPC patterns, debugging
- `docs/themes/theme-system.md` — Theme pipeline, core model, component overrides, runtime
- `docs/themes/theme-tokens.md` — Complete semantic token reference
- `docs/e2e-testing.md` — Playwright E2E testing setup and patterns
- `docs/feature-curation.md` — Feature evaluation criteria
- `docs/release.md` — Release process
- `docs/sound-design.md` — Sound design guidelines
- `docs/architecture/` — Action system and terminal lifecycle docs
