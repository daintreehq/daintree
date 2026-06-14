# Daintree

**Overview:** Electron-based IDE for orchestrating AI coding agents (Claude, Gemini, Codex). Orchestrates AI-assisted development: spawn agents, inject codebase context, monitor worktrees. **Stack:** Electron 42, React 19, Vite 8, TypeScript 6, Tailwind CSS v4, Zustand 5, node-pty, simple-git, @xterm/xterm 6.1 beta.

## Critical Rules

1. **Dependencies:** Use `npm install` for local development. `npm ci` is acceptable for CI environments where reproducible builds are critical. Both commands run the `postinstall` rebuild hook automatically unless `--ignore-scripts` is used.
2. **Native Modules:** The `postinstall` script rebuilds `node-pty` automatically. Run `npm run rebuild` manually if errors occur.
3. **Code Style:** Minimal comments, no decorative headers, high signal-to-noise.
4. **Commits:** NEVER commit changes without explicit permission from the user.
5. **Agent Config Boundary:** Never modify user-owned agent configuration (`~/.claude/settings.json`, `~/.gemini/`, user hooks, agent-native settings files). This includes additive CLI injection like Claude's `--settings` flag—adding hooks or config still changes the user's session behavior. If a capability requires altering user agent config, it's out of scope. Use passive observation instead (output parsing, OSC title sniffing, process-tree state). Precedent: issue #4100.

## Commands

```bash
npm run dev          # Vite + Electron concurrent
npm run build        # Production build
npm run check        # typecheck + lint + format
npm run fix          # Auto-fix lint/format
npm run rebuild      # Rebuild node-pty
```

## Architecture

- **Main (`electron/`):** Electron main process. Handles windows, service registration, IPC, native OS access, and UtilityProcess lifecycle.
- **Utility hosts:** `electron/pty-host.ts` owns node-pty; `electron/workspace-host.ts` owns git/worktree monitoring; `electron/watchdog-host.ts` watches main-process liveness.
- **Renderer (`src/`):** React 19. Communicates via `window.electron` and direct MessagePorts brokered by main.
- **Shared (`shared/`):** Types and config shared between processes.

### Actions System

Central orchestration layer for all UI operations. Provides unified API for menus, keybindings, and future agent automation.

- `ActionService` (`src/services/ActionService.ts`) - Registry and dispatcher
- `dispatch(actionId, args?)` - Execute any action
- `list()` / `get(id)` - Introspect actions (MCP-compatible manifest)
- Action definitions in `src/services/actions/definitions/`, registered through `src/services/actions/actionDefinitions.ts`
- Types in `shared/types/actions.ts`

### Panel Architecture

Panels are visual units in the grid/dock. Uses discriminated unions:

- `PanelInstance = PtyPanelData | BrowserPanelData | DevPreviewPanelData | ReviewPanelData`
- Built-in kinds: `"terminal"` | `"browser"` | `"dev-preview"` | `"review"`
- Agent identity is runtime state inside a PTY-backed terminal, not a separate panel kind.
- `panelKindHasPty(kind)` - Check if panel needs PTY
- Registry: `shared/config/panelKindRegistry.ts`

### IPC Bridge (`window.electron`)

Namespaced API exposed via `electron/preload.cts`:

- `worktree`: getAll, refresh, setActive, create, delete, onUpdate
- `terminal`: spawn, write, resize, kill, trash, restore, onData, onExit
- `app`: getState, setState, hydrate, onMenuAction
- `forge`: provider-routed issue/PR/CI operations
- `system`: openExternal, openPath, checkCommand
- `project`: getAll, getCurrent, add, switch, onSwitch
- `mcpServer`, `plugin`, `appAgent`, `agentCapabilities`: agent and extension control surfaces
- `events`: emit (action tracking)

## Key Features

- **Panels:** PTY host + xterm.js power terminal panels; browser, dev-preview, and review panels are non-PTY panel kinds.
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
│   ├── panel.ts         # Panel types
│   ├── project.ts       # Project types
│   ├── worktree.ts      # Worktree types
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

1. Add ID to `shared/config/actionIds.ts`
2. Create definition in `src/services/actions/definitions/`
