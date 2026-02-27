# Canopy Command Center

**The AI-Native Mini IDE for Agent Orchestration**

Canopy is a feature-rich, Electron-based command center designed to streamline the workflow of developing with AI coding agents. It bridges the gap between your terminal, git worktrees, and AI CLI tools like Claude Code, Gemini, Codex, and OpenCode.

Instead of juggling multiple terminal windows and manually copying context, Canopy provides a unified dashboard to monitor worktrees, orchestrate agents, and inject codebase context with a single click.

## Key Features

### Worktree Dashboard

- **Visual Monitoring**: View all git worktrees at a glance with real-time status updates
- **Smart Summaries**: Commit-based summaries of changes in every branch
- **GitHub Integration**: Auto-detects associated Pull Requests and Issues based on branch names
- **Dev Server Control**: Auto-detects `package.json` scripts and manages dev server lifecycles per worktree
- **Mood Indicators**: Visual prioritization with stable, active, stale, and error states

### Agent Orchestration

- **Smart Terminals**: Integrated panel grid capable of running standard shells or AI agents
- **Lifecycle Tracking**: Automatically detects agent states (`idle`, `working`, `waiting`, `completed`, `failed`) via output heuristics
- **Waiting For You**: A dedicated notification strip that alerts you when an agent needs human input
- **Activity Monitoring**: Semantic analysis of terminal output with human-readable status headlines

### Context Injection

- **One-Click Context**: Integrated with [CopyTree](https://github.com/gregpriday/copytree) for intelligent context generation
- **Smart Selection**: Pick specific files or folders to inject into the active agent's terminal
- **Format Optimization**: Generates context in XML format optimized for AI agent consumption

### Multi-Panel Terminal Environment

- **Drag-and-Drop Layout**: Reorderable panel grid with dnd-kit integration
- **Resizable Panels**: Dock and trash system for terminal organization
- **Performance Modes**: Memoized rendering and configurable optimizations for multi-terminal workflows
- **Hybrid Input Bar**: Command submission without typing directly in terminal
- **State Persistence**: Auto-hibernation of inactive projects and terminal state persistence across sessions

### GitHub Integration

- **PR/Issue Detection**: Automatic linking from branch names
- **Repository Stats**: Commit lists and statistics
- **Secure Authentication**: Token-based auth with persistent local storage

## Prerequisites

- **Node.js**: v22+ required
- **Git**: v2.30+
- **AI Agents (Optional)**: For the best experience, install the CLIs for the agents you intend to use:

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code

# Codex CLI
npm install -g @openai/codex

# OpenCode CLI
npm install -g opencode-ai@latest
```

## Getting Started

### Installation

1. **Clone the repository:**

   ```bash
   git clone https://github.com/gregpriday/canopy-electron.git
   cd canopy-electron
   ```

2. **Install dependencies:**

   > **Note:** This project includes native modules (`node-pty`) that must be built against the Electron runtime. Both `npm install` and `npm ci` work correctly - the `postinstall` script handles the rebuild automatically.

   ```bash
   npm install  # or npm ci for CI environments
   ```

3. **Rebuild Native Modules (if needed):**

   The post-install script should handle this, but if you see errors regarding `node-pty`, run:

   ```bash
   npm run rebuild
   ```

### Running the App

Start the development environment (runs Vite renderer and Electron main process concurrently):

```bash
npm run dev
```

## Configuration

Canopy works out of the box for local terminal management, but AI features require configuration via the **Settings** icon (bottom left sidebar).

1. **GitHub Token**: Required for fetching PR statuses and issue details without hitting rate limits
2. **Agent Settings**: Configure default models and flags for Claude, Gemini, Codex, and OpenCode

## Architecture

Canopy uses a modern Electron architecture with a three-tier model:

```
Main Process (electron/)          Renderer (src/)
    ├── Services                      ├── Components (React 19)
    ├── IPC Handlers                  ├── Zustand Stores
    ├── PTY Management                ├── Hooks & Clients
    └── UtilityProcesses              └── UI Logic
         ├── PTY Host
         └── Workspace Host
```

### Process Architecture

- **Main Process (`/electron`)**: Handles native operations (PTY management, file system, git) via TypeScript services. Exposes functionality through a secure IPC bridge.
- **Renderer Process (`/src`)**: React 19 UI with Vite HMR. Uses Zustand for state management with atomic selectors for performance.
- **Utility Processes**: Isolated PTY Host (SharedRingBuffer flow control) and Workspace Host (git worktree monitoring).

### Actions System

The central orchestration layer for all UI operations:

- **ActionService** (`src/services/ActionService.ts`): Registry and dispatcher singleton
- **20 Domain Files**: Terminal, agent, panel, worktree, worktree-session, project, GitHub, git, navigation, app, preferences, browser, system, logs, recipes, assistant, notes, workflow, dev-server, introspection
- **Typed API**: `dispatch(actionId, args?, options?)` with Zod validation
- **Safety Levels**: `ActionDanger` ("safe" | "confirm" | "restricted")
- **Source Tracking**: `ActionSource` ("user" | "keybinding" | "menu" | "agent" | "context-menu")

### Panel System

Extensible discriminated union architecture:

```typescript
PanelInstance = PtyPanelData | BrowserPanelData | NotesPanelData | DevPreviewPanelData;
BuiltInPanelKind = "terminal" | "agent" | "browser" | "notes" | "dev-preview";
```

- **Panel Registry**: Extensible configuration in `shared/config/panelKindRegistry.ts`
- **PTY Detection**: `panelKindHasPty(kind)` for process management

### IPC Bridge (`window.electron`)

Namespaced API for renderer → main communication (34 namespaces, selected highlights below):

| Namespace  | Key Methods                                                                         |
| ---------- | ----------------------------------------------------------------------------------- |
| `worktree` | getAll, refresh, setActive, create, delete, onUpdate, attachIssue                   |
| `terminal` | spawn, write, resize, kill, trash, restore, onData, onExit, submit, onAgentDetected |
| `app`      | getState, setState, hydrate, onMenuAction, quit, getVersion                         |
| `copyTree` | generate, injectToTerminal, isAvailable, cancel, onProgress                         |
| `github`   | openIssues, openPRs, listIssues, listPullRequests, getConfig, setToken              |
| `project`  | getAll, getCurrent, add, remove, update, switch, getSettings, saveSettings          |
| `system`   | openExternal, openPath, checkCommand, checkDirectory, getCliAvailability            |
| `logs`     | getAll, getSources, clear, openFile, onEntry                                        |
| `events`   | emit (action tracking)                                                              |
| `appAgent` | dispatch, confirm, getTools, onResponse                                             |
| `artifact` | detect, save, patch, getAll                                                         |
| `git`      | diff, pulse, commits                                                                |
| `notes`    | get, save, delete                                                                   |
| `commands` | list, get, execute                                                                  |
| `window`   | fullscreen, zoom, devtools                                                          |
| `update`   | onAvailable, install                                                                |

> See `src/types/electron.d.ts` for the complete typed API surface.

### Key Technologies

| Component          | Technology                                   |
| ------------------ | -------------------------------------------- |
| Runtime            | Electron 40                                  |
| UI Framework       | React 19 + TypeScript                        |
| Build              | Vite 6                                       |
| State Management   | Zustand v5 (atomic selectors)                |
| Terminal Emulation | @xterm/xterm v6.0 + addons                   |
| PTY                | node-pty v1.0 (native module)                |
| Git                | simple-git v3.30                             |
| Styling            | Tailwind CSS v4                              |
| Drag & Drop        | dnd-kit (sortable)                           |
| Validation         | Zod + zod-to-json-schema                     |
| AI Integration     | Agent CLIs (Claude, Gemini, Codex, OpenCode) |

## Directory Structure

```
canopy-electron/
├── electron/                    # Main process
│   ├── main.ts                  # Entry point
│   ├── preload.cts              # IPC bridge (contextBridge)
│   ├── menu.ts                  # Application menu
│   ├── pty-host.ts              # PTY UtilityProcess
│   ├── workspace-host.ts        # Workspace UtilityProcess
│   ├── ipc/
│   │   ├── channels.ts          # Channel constants
│   │   ├── handlers.ts          # Handler registration
│   │   └── handlers/            # Domain-specific handlers
│   └── services/                # Backend services
│       ├── pty/                 # Terminal subsystem
│       ├── workspace-host/      # Worktree monitoring
│       └── github/              # GitHub integration
│
├── src/                         # Renderer (React)
│   ├── components/
│   │   ├── Layout/              # App shell (AppLayout, Sidebar, Toolbar)
│   │   ├── Terminal/            # xterm.js grid
│   │   ├── Worktree/            # Dashboard cards
│   │   ├── Panel/               # Panel system
│   │   ├── Sidecar/             # Browser/artifact viewer
│   │   ├── DragDrop/            # dnd-kit integration
│   │   └── Settings/            # Configuration UI
│   ├── store/                   # Zustand stores
│   │   ├── terminalStore.ts     # Panel state management
│   │   ├── worktreeStore.ts     # Worktree state
│   │   └── slices/              # Store slices
│   ├── hooks/                   # React hooks
│   ├── clients/                 # IPC wrappers
│   └── services/
│       ├── ActionService.ts     # Action dispatcher
│       └── actions/definitions/ # 20 action definition files
│
├── shared/                      # Shared types & config
│   ├── types/
│   │   ├── actions.ts           # Action system types
│   │   ├── domain.ts            # Panel, Worktree, Agent types
│   │   └── keymap.ts            # Keybinding types
│   └── config/
│       ├── panelKindRegistry.ts # Panel configuration
│       └── agentRegistry.ts     # Agent configuration
│
├── docs/                        # Documentation
│   ├── architecture/            # Architecture docs (action-system, terminal-lifecycle)
│   ├── development.md
│   └── feature-curation.md
│
└── build/                       # Build assets
```

## Development Commands

```bash
# Start development (Electron + Vite concurrently)
npm run dev

# Run all checks (typecheck + lint + format) - use before committing
npm run check

# Auto-fix formatting and lint issues
npm run fix

# Run tests
npm run test

# Watch mode for tests
npm run test:watch

# Rebuild native modules (node-pty)
npm run rebuild
```

## Build & Distribute

```bash
# Full production build
npm run build

# Package for distribution (auto-detects platform)
npm run package

# Platform-specific packaging
npm run package:mac
npm run package:win
npm run package:linux
```

## Notable Implementation Details

- **SharedArrayBuffer Flow Control**: PTY host uses lock-free SharedRingBuffer with Atomics for low-latency backpressure
- **Terminal State Persistence**: Auto-hibernation of inactive projects with configurable thresholds; terminal state persisted across sessions
- **Multi-Project Support**: Services filter by projectId; stores reset on project switch
- **Artifact Detection**: Automatic detection and inline viewing of AI-generated code changes
- **Dev Server Auto-Detection**: Scans package.json, Makefiles, Django, and Composer configs to detect and manage dev server lifecycles

## Documentation

- [Architecture](docs/architecture/) - System design, IPC patterns, project structure
- [Development Guide](docs/development.md) - Setup, commands, debugging
- [Feature Curation](docs/feature-curation.md) - Feature evaluation criteria

## License

MIT License
