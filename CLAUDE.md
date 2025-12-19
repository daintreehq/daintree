# Canopy Command Center

**Overview:** Electron-based IDE for orchestrating AI coding agents (Claude, Gemini, Codex). Features integrated terminals, worktree dashboard, and context injection.
**Stack:** Electron 33, React 19, Vite 6, TypeScript, Tailwind CSS v4, Zustand, node-pty, simple-git.

## Critical Rules

1. **Dependencies:** ALWAYS use `npm install`. NEVER use `npm ci` (package-lock is ignored).
2. **Native Modules:** `node-pty` must be rebuilt for Electron. `npm install` runs the rebuild hook automatically. If errors occur, run `npm run rebuild`.
3. **Code Style:** Minimal comments. No decorative headers. High signal-to-noise ratio.
4. **Codex MCP:** When calling `mcp__codex__codex`, always set `model: "gpt-5.2"`. Include file paths in prompts—Codex reads files directly and gives better advice when it can see the actual code.
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

### IPC Bridge (`window.electron`)

Access native features via namespaced API in Renderer. Returns Promises or Cleanups.

- `worktree`: getAll, refresh, setActive, onUpdate, onRemove
- `terminal`: spawn, write, resize, kill, onData, onExit, onAgentStateChanged
- `devServer`: start, stop, toggle, getState, getLogs, onUpdate
- `copyTree`: generate, injectToTerminal, isAvailable, cancel, onProgress
- `system`: openExternal, openPath, getConfig, checkCommand
- `project`: getAll, getCurrent, add, remove, update, switch, onSwitch
- `logs`: getAll, getSources, clear, openFile, onEntry
- `errors`: onError, retry, openLogs
- `eventInspector`: getEvents, getFiltered, clear, subscribe, onEvent

## Key Features & Implementation

- **Terminals:** `PtyManager` manages node-pty processes, `XtermAdapter` renders via xterm.js.
- **Worktrees:** `WorktreeService` polls git status. `WorktreeMonitor` tracks individual worktrees.
- **Agent State:** `AgentStateMachine` tracks idle/working/waiting/completed via output heuristics.
- **Context:** `CopyTreeService` generates context for agents, injects into terminals.
- **Dev Server:** `DevServerManager` auto-detects `package.json` scripts, manages lifecycle.

## Directory Map

```text
electron/
├── main.ts              # Entry point
├── preload.cts          # IPC bridge (contextBridge)
├── ipc/
│   ├── channels.ts      # Channel constants
│   ├── handlers.ts      # IPC request handlers
│   └── types.ts         # IPC type definitions
├── services/
│   ├── PtyManager.ts        # Terminal process management
│   ├── WorktreeService.ts   # Worktree monitoring
│   ├── DevServerManager.ts  # Dev server lifecycle
│   ├── AgentStateMachine.ts # Agent state tracking
│   └── CopyTreeService.ts   # Context generation
└── utils/
    ├── logger.ts        # Logging
    └── git.ts           # Git operations

src/
├── components/
│   ├── Terminal/        # Xterm.js grid & controls
│   ├── Worktree/        # Dashboard cards
│   ├── Layout/          # AppLayout, Sidebar, Toolbar
│   └── Settings/        # Configuration UI
├── store/               # Zustand stores (terminalStore, worktreeStore)
├── hooks/               # React hooks (useWorktrees, useAgentLauncher)
└── types/
    └── electron.d.ts    # TypeScript declarations for window.electron
```

## Documentation

- `docs/development.md` — Architecture, IPC patterns, debugging
- `docs/feature-curation.md` — Feature evaluation criteria
