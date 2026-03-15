# Canopy — Codex Agent Guide

You will be asked for implementation guides and code reviews. This file gives you the code structure and conventions needed to respond quickly and accurately.

## Stack

Electron 40, React 19, Vite 6, TypeScript, Tailwind CSS v4, Zustand, node-pty, simple-git, @xterm/xterm 6.0, @xterm/addon-fit 0.11.

**Version-critical notes:** Electron 40 has breaking changes from earlier versions (e.g., `console-message` event signature changed in v35, `WebRequestFilter` empty `urls` behavior changed, macOS 11 dropped in v38, utility processes crash on unhandled rejections in v37). @xterm/xterm 6.0 removed the canvas renderer addon, removed `windowsMode`/`fastScrollModifier`, replaced the viewport/scrollbar with VS Code's implementation, and migrated from EventEmitter to VS Code's Emitter pattern. Always review code against these exact versions.

## Repo

Public repo: `canopyide/canopy` — https://github.com/canopyide/canopy

## Project Structure

```text
electron/                    # Main process
├── main.ts                  # Entry point
├── preload.cts              # IPC bridge (contextBridge)
├── menu.ts                  # Application menu
├── pty-host.ts              # PTY process host
├── workspace-host.ts        # Worktree monitoring host
├── ipc/
│   ├── channels.ts          # Channel constants
│   ├── handlers.ts          # IPC request handlers
│   └── handlers/            # Domain-specific handlers
└── services/                # Backend services

shared/                      # Shared between main & renderer
├── types/
│   ├── actions.ts           # ActionId union, ActionDefinition, ActionManifestEntry
│   ├── domain.ts            # Panel, Worktree, Agent types
│   ├── keymap.ts            # KeyAction union, keybinding types
│   └── ipc/                 # IPC type definitions
└── config/
    ├── panelKindRegistry.ts # Panel kind configuration
    └── agentRegistry.ts     # Agent configuration

src/                         # Renderer (React 19)
├── services/
│   ├── ActionService.ts     # Action registry & dispatcher singleton
│   └── actions/
│       ├── actionDefinitions.ts  # Registration entry point
│       ├── actionTypes.ts        # Callback interfaces
│       └── definitions/          # 20 domain-specific action files
├── components/
│   ├── Terminal/            # Xterm.js grid & controls
│   ├── Worktree/            # Dashboard cards
│   ├── Panel/               # Panel header & controls
│   ├── PanelPalette/        # Panel spawn palette
│   ├── Layout/              # AppLayout, Sidebar, Toolbar
│   └── Settings/            # Configuration UI
├── store/
│   ├── terminalStore.ts     # Panel state management
│   ├── slices/              # Store slices (registry, focus, etc.)
│   └── persistence/         # State persistence
├── hooks/
│   ├── useActionRegistry.ts # Action registration hook
│   ├── useMenuActions.ts    # Menu → action dispatch
│   └── useKeybinding.ts     # Keybinding handlers
├── clients/                 # IPC client wrappers
└── types/
    └── electron.d.ts        # window.electron types
```

Tests live in `__tests__/` folders beside source files.

## Key Architecture

### Actions System

Central dispatcher for all UI operations (`src/services/ActionService.ts`):

- `dispatch(actionId, args?, options?)` — Execute any action by ID
- `list()` / `get(id)` — Introspect available actions (MCP-compatible manifest)
- `ActionSource`: "user" | "keybinding" | "menu" | "agent" | "context-menu"
- `ActionDanger`: "safe" | "confirm" | "restricted"
- Definitions in `src/services/actions/definitions/` (20 files, one per domain)
- Types in `shared/types/actions.ts`

### Panel Architecture

Discriminated union types for type safety:

- `PanelInstance = PtyPanelData | BrowserPanelData | NotesPanelData | DevPreviewPanelData`
- Built-in kinds: `"terminal"` | `"agent"` | `"browser"` | `"notes"` | `"dev-preview"`
- `panelKindHasPty(kind)` — Check if panel needs PTY
- Registry: `shared/config/panelKindRegistry.ts`

### IPC Bridge (`window.electron`)

Renderer accesses main via namespaced API. Returns Promises or Cleanups.

- Types: `src/types/electron.d.ts`
- Channels: `electron/ipc/channels.ts`
- Handlers: `electron/ipc/handlers/` (domain-specific files)
- Preload: `electron/preload.cts`

### Terminal System

- `PtyManager` (main process) manages node-pty processes
- `terminalInstanceService` (renderer) manages xterm.js instances
- Uses @xterm/xterm 6.0 with @xterm/addon-fit 0.11 (DOM or WebGL renderer only — no canvas addon)

### State Management

Zustand stores in `src/store/` with slices pattern. Panel state in `terminalStore.ts`.

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

PRs run typecheck, lint, format, and unit tests only — no E2E. Full E2E suites run nightly and as release gates. Add the `run-e2e` label to a PR to trigger E2E core and online tests on every commit (use when working on E2E tests).

Theme docs: `docs/architecture/theme-system.md`

## Adding New Features

**New action:** Add ID to `shared/types/actions.ts` → create definition in `src/services/actions/definitions/*.ts` → auto-registered via `useActionRegistry`.

**New IPC channel:** Define in `electron/ipc/channels.ts` → implement in `electron/ipc/handlers/` → expose in `electron/preload.cts` → type in `src/types/electron.d.ts`.
