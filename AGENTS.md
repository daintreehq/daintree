# Daintree — Codex Agent Guide

You will be asked for implementation guides and code reviews. This file gives you the code structure and conventions needed to respond quickly and accurately.

## Stack

Electron 41, React 19, Vite 8, TypeScript, Tailwind CSS v4, Zustand 5, node-pty, simple-git, @xterm/xterm 6.0, @xterm/addon-fit 0.11.

**Version-critical notes:** Electron 41 has breaking changes from earlier versions (e.g., `console-message` event signature changed in v35, `WebRequestFilter` empty `urls` behavior changed, macOS 11 dropped in v38, utility processes crash on unhandled rejections in v37). @xterm/xterm 6.0 removed the canvas renderer addon, removed `windowsMode`/`fastScrollModifier`, replaced the viewport/scrollbar with VS Code's implementation, and migrated from EventEmitter to VS Code's Emitter pattern. Always review code against these exact versions.

## Repo

Public repo: `canopyide/canopy` — https://github.com/canopyide/canopy

## Project Structure

```text
electron/                    # Main process
├── main.ts                  # Entry point
├── bootstrap.ts             # App bootstrap
├── preload.cts              # IPC bridge (contextBridge, 56 namespaces)
├── menu.ts                  # Application menu
├── pty-host.ts              # PTY process host
├── workspace-host.ts        # Worktree monitoring host
├── ipc/
│   ├── channels.ts          # Channel constants
│   ├── handlers.ts          # IPC request handlers
│   └── handlers/            # 52 top-level + subdirectory handlers (~87 total)
├── lifecycle/               # App lifecycle management
├── setup/                   # App setup/initialization
├── window/                  # Window management (ProjectViewManager, WindowRegistry, multi-window)
├── services/                # ~99 backend services
├── schemas/                 # Zod schemas
├── types/                   # Main process types
├── utils/                   # Utilities
└── resources/               # Static resources

shared/                      # Shared between main & renderer
├── types/
│   ├── actions.ts           # ActionId union, ActionDefinition, ActionManifestEntry
│   ├── panel.ts             # PanelInstance, PanelKind types
│   ├── keymap.ts            # KeyAction union, keybinding types
│   └── ipc/                 # IPC type definitions (27 files)
├── config/                  # panelKindRegistry, agentRegistry, scrollback, devServer, trash, etc.
└── theme/                   # Theme system — 14 built-in themes, palette/semantic/terminal tokens

src/                         # Renderer (React 19)
├── services/
│   ├── ActionService.ts     # Action registry & dispatcher singleton
│   └── actions/
│       ├── actionDefinitions.ts  # Registration entry point
│       ├── actionTypes.ts        # Callback interfaces
│       └── definitions/          # 28 domain-specific action files
├── panels/                  # Per-kind panel modules (terminal/, agent/, browser/, notes/, dev-preview/)
│   └── registry.tsx         # Unified panel kind registry (components + serializers + defaults)
├── components/              # 38 component directories (Terminal, Worktree, Panel,
│                            #   Layout, Settings, Browser, GitHub, DevPreview, etc.)
├── store/                   # 59 Zustand stores + slices (panelStore, projectStore, etc.)
├── hooks/                   # React hooks (useActionRegistry, useMenuActions, useKeybinding)
├── clients/                 # IPC client wrappers
└── types/
    └── electron.d.ts        # window.electron types
```

Tests live in `__tests__/` folders beside source files. `.daintree/recipes/*.json` files are intentionally tracked in git.

## Key Architecture

### Actions System

Central dispatcher for all UI operations (`src/services/ActionService.ts`):

- `dispatch(actionId, args?, options?)` — Execute any action by ID
- `list()` / `get(id)` — Introspect available actions (MCP-compatible manifest)
- `ActionSource`: "user" | "keybinding" | "menu" | "agent" | "context-menu"
- `ActionDanger`: "safe" | "confirm" | "restricted"
- Definitions in `src/services/actions/definitions/` (28 files, one per domain)
- Types in `shared/types/actions.ts`
- **Categories:** agent, app, artifacts, browser, copyTree, devServer, diagnostics, errors, files, git, github, help, introspection, logs, navigation, notes, panel, portal, preferences, project, recipes, settings, system, terminal, ui, voice, worktree

### Panel Architecture

Discriminated union types for type safety:

- `PanelInstance = PtyPanelData | BrowserPanelData | NotesPanelData | DevPreviewPanelData` (`shared/types/panel.ts`)
- Built-in kinds: `"terminal"` | `"agent"` | `"browser"` | `"notes"` | `"dev-preview"`
- `panelKindHasPty(kind)` — Check if panel needs PTY
- Config registry: `shared/config/panelKindRegistry.ts`
- Per-kind modules: `src/panels/<kind>/` (serializer, defaults, component). Unified in `src/panels/registry.tsx`

### IPC Bridge (`window.electron`)

Renderer accesses main via 56 namespaced APIs. Returns Promises or Cleanups.

- Types: `src/types/electron.d.ts`
- Channels: `electron/ipc/channels.ts`
- Handlers: `electron/ipc/handlers/` (52 top-level + subdirectory handlers)
- Preload: `electron/preload.cts`

### Multi-Window & Project Views

Each project gets its own `WebContentsView` with an independent V8 context. `ProjectViewManager` (`electron/window/ProjectViewManager.ts`) manages view creation, switching, and LRU eviction. Per-window services scoped via `WindowContext.services`; global services (PtyClient, WorkspaceClient) shared across windows.

### Terminal System

- `PtyManager` (main process) manages node-pty processes
- `terminalInstanceService` (renderer) manages xterm.js instances
- Uses @xterm/xterm 6.0 with @xterm/addon-fit 0.11 (DOM renderer only — no canvas addon)
- Worktree data delivered via per-view MessagePorts (`WorktreePortBroker`), not global IPC

### State Management

Zustand 5 stores in `src/store/` — 59 domain stores plus slices pattern. Panel state in `panelStore.ts`. Store uses normalized shape: `terminalsById: Record<string, PanelInstance>` + `terminalIds: string[]`.

## Coding Standards

- TypeScript everywhere. Explicit types for public APIs and IPC boundaries.
- Prettier: 2-space indent, double quotes, semicolons, trailing commas (es5), width 100.
- ESLint: React hooks rules, unused vars prefixed `_`, prefer `as const`.
- Naming: Components/hooks `PascalCase`, functions/vars `camelCase`, constants `SCREAMING_SNAKE_CASE`.
- Minimal comments, no decorative separators, high signal-to-noise.
- Conventional Commits: `feat(scope):`, `fix(scope):`, `chore:`.

## Commands

```bash
npm run dev          # Vite UI + Electron main
npm run build        # Full production build
npm test             # Vitest
npm run check        # typecheck + lint + format
npm run fix          # Auto-fix lint/format
npm run rebuild      # Rebuild native modules (node-pty)
```

### CI Testing Strategy

PRs run typecheck, lint, format, and unit tests only — no E2E. E2E tiers: `e2e/core/` (13 tests — gates releases), `e2e/full/` (61 tests — nightly), `e2e/online/` (2 agent integration tests — gates releases), `e2e/nightly/` (memory leak detection). Tagged releases wait for E2E to pass before publishing.

Theme docs: `docs/themes/theme-system.md`, `docs/themes/theme-tokens.md`

## Adding New Features

**New action:** Add ID to `shared/types/actions.ts` → create definition in `src/services/actions/definitions/*.ts` → auto-registered via `useActionRegistry`.

**New IPC channel:** Define in `electron/ipc/channels.ts` → implement in `electron/ipc/handlers/` → expose in `electron/preload.cts` → type in `src/types/electron.d.ts`.
