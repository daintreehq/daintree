# Canopy Command Center

**Overview:** Electron-based IDE for orchestrating AI coding agents (Claude, Gemini, Codex). Features integrated terminals, worktree dashboard, panel management, and context injection.
**Stack:** Electron 40, React 19, Vite 6, TypeScript, Tailwind CSS v4, Zustand, node-pty, simple-git, @xterm/xterm 6.0, @xterm/addon-fit 0.11.

## Critical Rules

1. **Dependencies:** Use `npm install` for local development. `npm ci` is acceptable for CI environments where reproducible builds are critical. Both commands run the `postinstall` rebuild hook automatically unless `--ignore-scripts` is used.
2. **Native Modules:** `node-pty` must be rebuilt for Electron. The `postinstall` script handles this automatically. If errors occur, run `npm run rebuild`.
3. **Code Style:** Minimal comments. No decorative headers. High signal-to-noise ratio.
4. **Codex MCP:** When calling `mcp__codex__codex`, always set `model: "gpt-5.4"`. Do NOT use any other model—ignore examples in the MCP definition like `o3`, `o4-mini`, etc. Only `gpt-5.4` is valid. Include file paths in prompts—Codex reads files directly and gives better advice when it can see the actual code.
5. **Human-Review Label:** The `human-review` label marks issues that cannot be solved autonomously—they require a developer checking logs, observing runtime behavior, or making subjective UX judgments. Adding this label makes an issue 10-20x more expensive (human time vs agent time), so use it sparingly. Only apply when the issue genuinely requires human observation or iterative debugging that an agent cannot perform. Most issues should NOT have this label. When working issues, skip any labeled `human-review`.
6. **GitHub Access:** Public repo `canopyide/canopy` (https://github.com/canopyide/canopy). Always use the `gh` CLI for all GitHub operations (issues, PRs, checks, releases, API calls). Do NOT use HTTP fetches or web scraping to access GitHub URLs—they will fail due to authentication. Examples: `gh issue list`, `gh pr view 123`, `gh api repos/canopyide/canopy/issues`.
7. **Research Versions:** When researching issues (e.g., via Ask Google MCP), always specify the actual versions we use: **Electron 40**, **@xterm/xterm 6.0**, **@xterm/addon-fit 0.11**, **React 19**. There are significant breaking changes between Electron 33 and 40 (e.g., `console-message` event signature changed in v35, `WebRequestFilter` empty `urls` array no longer matches all, macOS 11 dropped in v38, utility processes crash on unhandled rejections in v37). Similarly, xterm 6.0 removed the canvas renderer addon, removed `windowsMode`/`fastScrollModifier` options, replaced the viewport/scrollbar with VS Code's implementation, and migrated the event system. Do NOT assume older documentation is still accurate—always research for the exact versions.

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
- Action definitions (`src/services/actions/definitions/`) - 20 domain-specific action files
- Shared types (`shared/types/actions.ts`) - `ActionId`, `ActionDefinition`, `ActionManifestEntry`

**Key Concepts:**

- `dispatch(actionId, args?, options?)` - Execute any action by ID
- `list()` / `get(id)` - Introspect available actions (MCP-compatible manifest)
- `ActionSource` - Tracks origin: "user" | "keybinding" | "menu" | "agent" | "context-menu"
- `ActionDanger` - Safety levels: "safe" | "confirm" | "restricted"
- Actions emit events to the main process event bus for observability

**Action Categories:** terminal, agent, panel, worktree, worktreeSession, project, github, git, navigation, app, preferences, browser, system, logs, recipes, notes, workflow, devServer, file, introspection

### Panel Architecture

Panels are the visual units in the panel grid and dock. The system uses discriminated union types for type safety:

- `PanelInstance = PtyPanelData | BrowserPanelData | NotesPanelData | DevPreviewPanelData`
- Built-in panel kinds: `"terminal"` | `"agent"` | `"browser"` | `"notes"` | `"dev-preview"`
- `panelKindHasPty(kind)` - Check if panel requires PTY process
- Panel Kind Registry (`shared/config/panelKindRegistry.ts`) - Extensible for custom panels

### IPC Bridge (`window.electron`)

Access native features via namespaced API in Renderer. Returns Promises or Cleanups.

36 namespaces including: `worktree`, `terminal`, `files`, `copyTree`, `system`, `app`, `menu`, `logs`, `errors`, `events`, `project`, `github`, `notes`, `devPreview`, `git`, `sidecar`, `hibernation`, `keybinding`, `worktreeConfig`, `window`, `notification`, `update`, `gemini`, `commands`, `appAgent`, `agentCapabilities`, `clipboard`, and more.

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
├── main.ts                  # Entry point
├── preload.cts              # IPC bridge (contextBridge)
├── menu.ts                  # Application menu
├── store.ts                 # Main process store
├── windowState.ts           # Window state persistence
├── pty-host.ts              # PTY process host entry
├── pty-host/                # PTY host internals
├── workspace-host.ts        # Worktree monitoring host entry
├── workspace-host/          # WorkspaceService, WorktreeMonitor
├── ipc/
│   ├── channels.ts          # Channel constants
│   ├── handlers.ts          # IPC request handler registry
│   ├── errorHandlers.ts     # IPC error handling
│   └── handlers/            # Domain-specific handlers (clipboard, commands, copyTree,
│                            #   devPreview, git-write, github, keybinding, notifications,
│                            #   project, slashCommands, systemSleep, terminalConfig, worktree)
├── services/                # ~60 backend services (PtyManager, AgentStateMachine,
│                            #   CopyTreeService, GitService, GitHubService, WorkflowEngine,
│                            #   SidecarManager, HibernationService, etc.)
├── schemas/                 # Zod schemas (agent, external, ipc)
├── types/                   # Main process types
├── utils/                   # Utilities (git, cache, logger, soundPlayer, webviewCsp, etc.)
└── workflows/               # Workflow definitions

shared/
├── types/
│   ├── actions.ts           # ActionId union, ActionDefinition
│   ├── domain.ts            # Panel, Worktree, Agent types
│   ├── keymap.ts            # KeyAction union, keybinding types
│   ├── ipc/                 # IPC type definitions (~20 domain files)
│   └── ...                  # github, events, config, terminal, workflow, etc.
├── config/
│   ├── panelKindRegistry.ts # Panel kind configuration
│   ├── agentRegistry.ts     # Agent configuration
│   ├── devServer.ts         # Dev server configuration
│   └── scrollback.ts        # Scrollback settings
├── theme/                   # Theme system (entityColors, terminal, themes)
├── perf/                    # Performance marks
└── utils/                   # Shared utilities (shellEscape, pathPattern, svgSanitizer, etc.)

src/
├── services/
│   ├── ActionService.ts     # Action registry & dispatcher
│   ├── actions/
│   │   ├── actionDefinitions.ts  # Registration entry point
│   │   ├── actionTypes.ts        # Callback interfaces
│   │   └── definitions/          # 21 action definition files
│   ├── terminal/            # Terminal instance service
│   └── project/             # Project services
├── components/
│   ├── Terminal/            # Xterm.js grid & controls
│   ├── Worktree/            # Dashboard cards, ReviewHub, WorktreeCard
│   ├── Panel/               # Panel header & controls
│   ├── PanelPalette/        # Panel spawn palette
│   ├── Layout/              # AppLayout, Sidebar, Toolbar
│   ├── Settings/            # Configuration UI
│   ├── Browser/             # Embedded browser
│   ├── GitHub/              # GitHub integration UI
│   ├── DevPreview/          # Dev server preview
│   ├── Notes/               # Notes panel
│   ├── Commands/            # Command palette
│   ├── ContextInjection/    # Context injection UI
│   ├── Sidecar/             # Sidecar panel
│   ├── Pulse/               # Activity pulse
│   ├── QuickSwitcher/       # Quick panel switcher
│   ├── Onboarding/          # First-run onboarding
│   ├── Notifications/       # Notification UI
│   ├── ActionPalette/       # Action palette
│   ├── TerminalPalette/     # Terminal palette
│   ├── TerminalRecipe/      # Terminal recipes
│   ├── FileViewer/          # File viewer
│   ├── ui/                  # Shared UI primitives
│   └── icons/               # Icon components
├── store/
│   ├── terminalStore.ts     # Panel state management
│   ├── slices/              # Store slices (registry, focus, MRU, bulk actions, command queue)
│   └── persistence/         # State persistence
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
- `docs/e2e-testing.md` — Playwright E2E testing setup and patterns
- `docs/feature-curation.md` — Feature evaluation criteria
