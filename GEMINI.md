# Canopy Command Center

**Overview:** Electron-based IDE for orchestrating AI coding agents (Claude, Gemini, Codex). Acts as "Mission Control" for AI-assisted development: spawn agents, inject codebase context, monitor worktrees.
**Stack:** Electron 33, React 19, Vite 6, TypeScript, Tailwind CSS v4, Zustand, node-pty, simple-git.

## Critical Rules

1. **Dependencies:** Use `npm install`, never `npm ci` (package-lock is ignored).
2. **Native Modules:** Run `npm run rebuild` if node-pty errors occur.
3. **Code Style:** Minimal comments, no decorative headers, high signal-to-noise.
4. **Commits:** NEVER commit changes without explicit permission from the user.

## Commands

```bash
npm run dev          # Vite + Electron concurrent
npm run build        # Production build
npm run check        # typecheck + lint + format
npm run fix          # Auto-fix lint/format
npm run rebuild      # Rebuild node-pty
```

## Architecture

- **Main (`electron/`):** Node.js. Handles node-pty, git, services, IPC.
- **Renderer (`src/`):** React 19. Communicates via `window.electron`.
- **Shared (`shared/`):** Types and config shared between processes.

### Actions System

Central orchestration layer for all UI operations. Provides unified API for menus, keybindings, and future agent automation.

- `ActionService` (`src/services/ActionService.ts`) - Registry and dispatcher
- `dispatch(actionId, args?)` - Execute any action
- `list()` / `get(id)` - Introspect actions (MCP-compatible manifest)
- Action definitions in `src/services/actions/definitions/` (17 domain files)
- Types in `shared/types/actions.ts`

### Panel Architecture

Panels are visual units in the grid/dock. Uses discriminated unions:

- `PanelInstance = PtyPanelData | BrowserPanelData`
- Kinds: `"terminal"` | `"agent"` | `"browser"`
- `panelKindHasPty(kind)` - Check if panel needs PTY
- Registry: `shared/config/panelKindRegistry.ts`

### IPC Bridge (`window.electron`)

Namespaced API exposed via `electron/preload.cts`:

- `worktree`: getAll, refresh, setActive, create, delete, onUpdate
- `terminal`: spawn, write, resize, kill, trash, restore, onData, onExit
- `app`: getState, setState, hydrate, onMenuAction
- `copyTree`: generate, injectToTerminal, onProgress
- `system`: openExternal, openPath, checkCommand
- `project`: getAll, getCurrent, add, switch, onSwitch
- `events`: emit (action tracking)

## Key Features

- **Panels:** `PtyManager` (Main) + xterm.js (Renderer). Supports terminal, agent, and browser panels.
- **Worktrees:** `WorkspaceService` polls git status, tracks file changes.
- **Agent State:** `AgentStateMachine` detects idle/working/waiting/completed from output.
- **Context Injection:** `CopyTreeService` generates context, pastes into terminal.
- **Actions:** `ActionService` dispatches all operations with validation and event emission.

## Directory Map

```text
electron/
├── main.ts              # Entry point
├── preload.cts          # IPC bridge
├── pty-host.ts          # PTY process host
├── ipc/
│   ├── channels.ts      # Channel constants
│   └── handlers/        # IPC implementations
└── services/            # Backend services

shared/
├── types/
│   ├── actions.ts       # Action system types
│   ├── domain.ts        # Panel, Worktree types
│   └── keymap.ts        # Keybinding types
└── config/
    ├── panelKindRegistry.ts  # Panel configuration
    └── agentRegistry.ts      # Agent configuration

src/
├── services/
│   ├── ActionService.ts      # Action dispatcher
│   └── actions/definitions/  # Action definitions
├── components/
│   ├── Terminal/        # Xterm.js grid
│   ├── Worktree/        # Dashboard cards
│   └── Layout/          # App structure
├── store/               # Zustand stores
├── hooks/               # React hooks
└── types/electron.d.ts  # window.electron types
```

## Common Tasks

**Adding IPC channel:**

1. Define in `electron/ipc/channels.ts`
2. Implement in `electron/ipc/handlers/`
3. Expose in `electron/preload.cts`
4. Type in `src/types/electron.d.ts`

**Adding action:**

1. Add ID to `shared/types/actions.ts`
2. Create definition in `src/services/actions/definitions/`
