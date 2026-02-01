# Canopy Command Center

**Overview:** Electron-based IDE for orchestrating AI coding agents (Claude, Gemini, Codex). Features integrated terminals, worktree dashboard, panel management, and context injection.
**Stack:** Electron 33, React 19, Vite 6, TypeScript, Tailwind CSS v4, Zustand, node-pty, simple-git.

## Critical Rules

1. **Dependencies:** Use `npm install` for local development. `npm ci` is acceptable for CI environments where reproducible builds are critical. Both commands run the `postinstall` rebuild hook automatically unless `--ignore-scripts` is used.
2. **Native Modules:** `node-pty` must be rebuilt for Electron. The `postinstall` script handles this automatically. If errors occur, run `npm run rebuild`.
3. **Code Style:** Minimal comments. No decorative headers. High signal-to-noise ratio.
4. **Codex MCP:** When calling `mcp__codex__codex`, always set `model: "gpt-5.2-codex"`. Do NOT use any other model—ignore examples in the MCP definition like `o3`, `o4-mini`, etc. Only `gpt-5.2-codex` is valid. Include file paths in prompts—Codex reads files directly and gives better advice when it can see the actual code.
5. **Human-Review Label:** The `human-review` label marks issues that cannot be solved autonomously—they require a developer checking logs, observing runtime behavior, or making subjective UX judgments. Adding this label makes an issue 10-20x more expensive (human time vs agent time), so use it sparingly. Only apply when the issue genuinely requires human observation or iterative debugging that an agent cannot perform. Most issues should NOT have this label. When working issues, skip any labeled `human-review`.

## Development

```bash
npm run dev          # Start Main + Renderer (Vite)
npm run build        # Production build
npm run check        # typecheck + lint + format
npm run fix          # Auto-fix lint/format issues
npm run package      # Distribute
npm run rebuild      # Rebuild native modules
```

## Architecture

- **Main (`electron/`):** Handles node-pty, git operations, services, and IPC.
- **Renderer (`src/`):** React 19 UI. Communicates via `window.electron`.
- **Shared (`shared/`):** Types and config shared between main and renderer.

### Actions System

The **Actions System** is the central orchestration layer for all UI operations. It provides a unified, typed API for menus, keybindings, context menus, and future agent automation.

**Core Components:**

- `ActionService` (`src/services/ActionService.ts`) - Registry and dispatcher singleton
- Action definitions (`src/services/actions/definitions/`) - 17 domain-specific action files
- Shared types (`shared/types/actions.ts`) - `ActionId`, `ActionDefinition`, `ActionManifestEntry`

**Key Concepts:**

- `dispatch(actionId, args?, options?)` - Execute any action by ID
- `list()` / `get(id)` - Introspect available actions (MCP-compatible manifest)
- `ActionSource` - Tracks origin: "user" | "keybinding" | "menu" | "agent" | "context-menu"
- `ActionDanger` - Safety levels: "safe" | "confirm" | "restricted"
- Actions emit events to the main process event bus for observability

**Action Categories:** terminal, agent, panel, worktree, project, github, git, navigation, app, preferences, browser, system, logs, recipes

### Panel Architecture

Panels are the visual units in the panel grid and dock. The system uses discriminated union types for type safety:

- `PanelInstance = PtyPanelData | BrowserPanelData`
- Built-in panel kinds: `"terminal"` | `"agent"` | `"browser"`
- `panelKindHasPty(kind)` - Check if panel requires PTY process
- Panel Kind Registry (`shared/config/panelKindRegistry.ts`) - Extensible for custom panels

### IPC Bridge (`window.electron`)

Access native features via namespaced API in Renderer. Returns Promises or Cleanups.

- `worktree`: getAll, refresh, setActive, create, delete, onUpdate, onRemove
- `terminal`: spawn, write, resize, kill, trash, restore, onData, onExit, onAgentStateChanged
- `app`: getState, setState, hydrate, onMenuAction, quit
- `copyTree`: generate, injectToTerminal, isAvailable, cancel, onProgress
- `system`: openExternal, openPath, checkCommand, checkDirectory, getHomeDir
- `project`: getAll, getCurrent, add, remove, update, switch, onSwitch
- `logs`: getAll, getSources, clear, openFile, onEntry
- `events`: emit (for action tracking)
- `github`: openIssues, openPRs, listIssues, listPullRequests, getConfig, setToken

## Key Features & Implementation

- **Panels:** `PtyManager` (Main) manages node-pty processes. `terminalInstanceService` (Renderer) manages xterm.js instances.
- **Worktrees:** `WorkspaceService` polls git status. `WorktreeMonitor` tracks individual worktrees.
- **Agent State:** `AgentStateMachine` tracks idle/working/waiting/completed via output heuristics.
- **Context:** `CopyTreeService` generates context for agents, injects into terminals.
- **Actions:** `ActionService` dispatches all UI operations with validation and observability.

### Assistant Debugging

The Canopy Assistant logs all requests and responses for debugging. Logs are development-only and cleared on app startup.

**Log Location:** `~/Library/Application Support/canopy-app/logs/assistant.log` (macOS)

**Format:** JSON Lines (one JSON object per line)

**Entry Types:**

- `request` — Messages, tools, context, model config sent to the AI
- `stream` — Individual events: `text-delta`, `tool-call`, `tool-result`, `error`
- `complete` — Request finished with finishReason and durationMs
- `error` — Request failed with error message
- `cancelled` — Request was cancelled by user

**Debugging Tool Calls:**

```bash
# View all tool calls and results
grep -E '"event":"(tool-call|tool-result)"' ~/Library/Application\ Support/canopy-app/logs/assistant.log

# View full request/response cycle
grep '"type":"request"\|"type":"complete"' ~/Library/Application\ Support/canopy-app/logs/assistant.log
```

**Key Files:**

- `electron/utils/assistantLogger.ts` — Logging infrastructure
- `electron/services/AssistantService.ts` — Request handling and stream processing
- `electron/services/assistant/actionTools.ts` — Action-to-tool conversion and allowlist

## Directory Map

```text
electron/
├── main.ts              # Entry point
├── preload.cts          # IPC bridge (contextBridge)
├── menu.ts              # Application menu
├── pty-host.ts          # PTY process host
├── workspace-host.ts    # Worktree monitoring host
├── ipc/
│   ├── channels.ts      # Channel constants
│   ├── handlers.ts      # IPC request handlers
│   └── handlers/        # Domain-specific handlers
└── services/            # Backend services

shared/
├── types/
│   ├── actions.ts       # Action system types
│   ├── domain.ts        # Panel, Worktree, Agent types
│   ├── keymap.ts        # KeyAction union, keybinding types
│   └── ipc/             # IPC type definitions
└── config/
    ├── panelKindRegistry.ts  # Panel kind configuration
    └── agentRegistry.ts      # Agent configuration

src/
├── services/
│   ├── ActionService.ts     # Action registry & dispatcher
│   └── actions/
│       ├── actionDefinitions.ts  # Registration entry point
│       ├── actionTypes.ts        # Callback interfaces
│       └── definitions/          # 17 action definition files
├── components/
│   ├── Terminal/        # Xterm.js grid & controls
│   ├── Worktree/        # Dashboard cards
│   ├── Panel/           # Panel header & controls
│   ├── PanelPalette/    # Panel spawn palette
│   ├── Layout/          # AppLayout, Sidebar, Toolbar
│   └── Settings/        # Configuration UI
├── store/
│   ├── terminalStore.ts # Panel state management
│   ├── slices/          # Store slices (registry, focus, etc.)
│   └── persistence/     # State persistence
├── hooks/
│   ├── useActionRegistry.ts  # Action registration hook
│   ├── useMenuActions.ts     # Menu → action dispatch
│   └── useKeybinding.ts      # Keybinding handlers
├── clients/             # IPC client wrappers
└── types/
    └── electron.d.ts    # window.electron types
```

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
- `docs/feature-curation.md` — Feature evaluation criteria
