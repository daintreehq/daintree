# Daintree

**Overview:** Electron-based IDE for orchestrating AI coding agents (Claude, Gemini, Codex). Features integrated terminals, worktree dashboard, panel management, and context injection.
**Stack:** Electron 41, React 19, Vite 8, TypeScript, Tailwind CSS v4, Zustand 5, node-pty, simple-git, @xterm/xterm 6.0, @xterm/addon-fit 0.11.

## Critical Rules

- **Dependencies:** Use `npm install` for local development. `npm ci` is acceptable for CI environments where reproducible builds are critical. Both commands run the `postinstall` rebuild hook automatically unless `--ignore-scripts` is used.
- **Native Modules:** `node-pty` must be rebuilt for Electron. The `postinstall` script handles this automatically. If errors occur, run `npm run rebuild`.
- **Code Style:** Minimal comments. No decorative headers. High signal-to-noise ratio.
- **Accent Color Restraint:** The accent color (`--color-accent-primary`, `text-accent-primary`, `outline-daintree-accent`, etc.) is a scarce resource, not a default highlight. If everything uses it, nothing stands out. Reserve it for _one_ genuinely load-bearing signal per view — a strong focus anchor, a primary CTA. Do NOT use it for: multi-select state, membership markers, secondary emphasis, "this is selected too" indicators, arming badges, or any treatment applied to multiple elements at once. For those, use the title-bar lift (`bg-overlay-subtle`), focus styling, or neutral surface differences. When in doubt, err on the side of NO accent — subtle wins.
- **Motion Timing:** Use the shared timing tiers unless the animation encodes semantic state. **Tier 1 — State changes (150ms `ease-out`):** hover, focus, active, selected, group-hover, toggle thumbs, drop-target rings, hover scrims, and other local UI feedback. Bare `transition-colors` (no explicit duration) inherits the app-wide 150ms default and needs no extra class; when a duration is required use `duration-150`. **Tier 2 — Deliberate entry/exit (200ms enter / 120ms exit):** modals, popovers, dropdowns, and surfaced dialogs. **Tier 2-fast — Palette/tooltip (150ms enter / 100ms exit):** command palettes and tooltips use a snappier sub-tier because typed-input flow expects faster response. **Tier 3 — Panel motion (200ms restore / 120ms minimize):** large-area choreographed reflow. Prefer the named constants in `src/lib/animationUtils.ts` (`UI_ANIMATION_DURATION` and `TERMINAL_ANIMATION_DURATION` for Tier 1; `UI_ENTER_DURATION`, `UI_EXIT_DURATION`, `UI_PALETTE_ENTER_DURATION`, `UI_PALETTE_EXIT_DURATION`, `PANEL_RESTORE_DURATION`, `PANEL_MINIMIZE_DURATION` for Tiers 2/3) when timing is expressed in TypeScript. **Semantic exceptions** — durations encoding meaning, not motion — must not be "fixed": `ActivityLight` 1000ms color fade (fade IS the decay indicator); progress bar 300–500ms width (width IS the progress signal); agent-state panel border 300ms (`ContentPanel` + `panel-state-*` classes — ambient, not jittery); welcome/empty-state hero fades 500ms (deliberately inviting); sidebar collapse 250ms `ease-out-expo` (large theatrical reflow); inline alert banner 200ms entry (`TerminalCountWarning`); diagnostics dock height 200ms; `FileChangeList` row-recency gutter bar 2000ms (`file-change-row-new` — the decay IS the arrival signal); GitHub toolbar digit flash 800ms (color decay from domain hue back to neutral IS the count-rose signal). Never widen scoped transitions (`transition-[width]`, `transition-[backdrop-filter]`, `transition-transform`, `transition-colors`) to bare `transition` or `transition-all`.
- **Loading Indicators:** Use the 400ms Doherty Threshold as the anti-flicker gate. **<400ms:** show nothing — drawing attention to a sub-threshold wait increases perceived load time. **400ms–1s:** use a skeleton (`animate-pulse-delayed`) when the layout shape is predictable; use `Spinner` only when the shape is unknown. **>1s:** skeleton mandatory when the shape is predictable. **>5s:** persistent skeleton plus a placeholder for a "Still working…" cue (exact copy decided separately). The default skeleton utility is `animate-pulse-delayed` (`src/index.css:1084`), whose `animation-delay: 400ms` enforces the gate automatically — elements stay invisible for 400ms, then fade in as a pulsing placeholder (`prefers-reduced-motion`, `data-reduce-animations`, and `data-performance-mode` bypass the gate by forcing `opacity: 1` / `animation: none`). `animate-pulse-immediate` (`src/index.css:1091`) skips the delay gate; reserve it only for cases where data is already known to exceed the threshold (e.g., in-flight network fetches). Canonical examples: `BrowserPaneSkeleton` (`src/components/Browser/BrowserPaneSkeleton.tsx`) for delayed-only, the exports in `GitHubDropdownSkeletons.tsx` (`src/components/GitHub/GitHubDropdownSkeletons.tsx`) for delayed + immediate variants. `Spinner` (`src/components/ui/Spinner.tsx`) has no built-in delay — never use it for sub-400ms waits or predictable-shaped content. `will-change: opacity` lives on the CSS utility class; never apply it per-element.
- **UI Microcopy:** Sentence case for titles, buttons, labels. No periods on titles, headings, or button labels (use periods on multi-sentence body text). Use unambiguous contractions (couldn't, didn't, can't). Drop "we" — write "Couldn't connect" not "We couldn't connect". Error toasts follow Title-Message-Action: title = concise verb-noun ("Connection failed"), message = 1-2 short sentences explaining why/how-to-fix, action = single contextual button (only when there's a real recovery action — no "Dismiss"). Destructive buttons use verb-noun labels ("Delete worktree", not "Delete" or "Confirm"). Toggle labels never change with state. Title names the thing; subtitle describes the behavior; the switch position conveys state. Confirmation dialogs: title is a sentence-case question naming the entity (`Delete 'foo'?`, not `Delete Foo`). Body states the specific consequence — never a generic "Are you sure". Button is verb-noun (`Delete recipe`).
- **notify() Usage:** `priority: "low"` skips toasts — goes straight to inbox (except `placement: "grid-bar"` which always renders inline). Don't use for errors users need to see immediately. `message` as `ReactNode` requires `inboxMessage` or history entry is silently dropped (`src/lib/notify.ts:218-229`).
- **Codex MCP:** When calling `mcp__codex__codex`, always set `model: "gpt-5.5"`. Do NOT use any other model—ignore examples in the MCP definition like `o3`, `o4-mini`, etc. Only `gpt-5.5` is valid. Include file paths in prompts—Codex reads files directly and gives better advice when it can see the actual code.
- **Human-Review Label:** The `human-review` label marks issues that cannot be solved autonomously—they require a developer checking logs, observing runtime behavior, or making subjective UX judgments. Adding this label makes an issue 10-20x more expensive (human time vs agent time), so use it sparingly. Only apply when the issue genuinely requires human observation or iterative debugging that an agent cannot perform. Most issues should NOT have this label. When working issues, skip any labeled `human-review`.
- **GitHub Access:** Public repo `daintreehq/daintree` (https://github.com/daintreehq/daintree). Always use the `gh` CLI for all GitHub operations (issues, PRs, checks, releases, API calls). Do NOT use HTTP fetches or web scraping to access GitHub URLs—they will fail due to authentication. Examples: `gh issue list`, `gh pr view 123`, `gh api repos/daintreehq/daintree/issues`.
- **Branching:** Gitflow model. **All PRs must target `develop`—NEVER `main`.** Only release merges go to `main`.
- **Tracked Configs:** `.daintree/recipes/*.json` files are intentionally tracked in git—do not remove or gitignore them.
- **Agent Config Boundary:** Never modify user-owned agent configuration (`~/.claude/settings.json`, `~/.gemini/`, user hooks, CLAUDE.md/AGENTS.md/GEMINI.md in user projects, any agent-native settings files). This includes additive CLI injection like Claude's `--settings` flag—adding hooks or config still changes the user's session behavior in ways they haven't opted into. If a capability requires altering user agent config, it's out of scope. Use passive observation instead (output parsing, OSC title sniffing, process-tree state, `AgentPatternDetector`-style regex). Precedent: #4100 removed Canopy-owned "Agent Instructions" for the same reason—agent-native config belongs to the user.
- **Research Versions:** When researching issues (e.g., via Ask Google MCP), always specify the actual versions we use: **Electron 41 (Chromium 146 — `build.target` is `chrome146` in `vite.config.ts`; bump in lockstep on each Electron major upgrade)**, **@xterm/xterm 6.0**, **@xterm/addon-fit 0.11**, **React 19**. There are significant breaking changes between Electron 33 and 41 (e.g., `console-message` event signature changed in v35, `WebRequestFilter` empty `urls` array no longer matches all, macOS 11 dropped in v38, utility processes crash on unhandled rejections in v37). Similarly, xterm 6.0 removed the canvas renderer addon, removed `windowsMode`/`fastScrollModifier` options, replaced the viewport/scrollbar with VS Code's implementation, and migrated the event system. Do NOT assume older documentation is still accurate—always research for the exact versions.

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

- **PRs / pushes:** Typecheck, lint, format, unit tests, and build on **Ubuntu only** (smoke on push only; no E2E, no budgets). `ci-ok` gate job is the sole required status check.
- **Nightly (2 AM UTC):** Full cross-platform CI on all 3 OSes: check + test + build + smoke + compiler / eager-import / renderer-bundle budgets + E2E full + E2E online + E2E nightly. Auto-creates GitHub issue on failure (`nightly-failure` label).
- **Releases:** E2E core and E2E online gate the release publish on macOS + Linux. Windows E2E is nightly-only.
- **E2E tiers:** `e2e/core/` (13 tests — gates releases), `e2e/full/` (61 tests — nightly), `e2e/online/` (2 agent integration tests — gates releases), `e2e/nightly/` (memory leak detection).
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
- ~258 built-in action IDs in `shared/types/actions.ts` — `BuiltInActionId`, `ActionDefinition`, `ActionManifestEntry`
- `dispatch(actionId, args?, options?)` — Execute any action by ID
- `list()` / `get(id)` — Introspect available actions (MCP-compatible manifest)
- `ActionSource`: "user" | "keybinding" | "menu" | "agent" | "context-menu"
- `ActionDanger`: "safe" | "confirm" | "restricted"
- **Categories:** agent, app, artifacts, browser, copyTree, devServer, diagnostics, errors, files, git, github, help, introspection, logs, navigation, notes, panel, portal, preferences, project, recipes, settings, system, terminal, ui, voice, worktree

### Panel Architecture

Discriminated union types for type safety:

- `PanelInstance = PtyPanelData | BrowserPanelData | DevPreviewPanelData` (`shared/types/panel.ts`)
- Built-in panel kinds: `"terminal"` | `"browser"` | `"dev-preview"`
- `panelKindHasPty(kind)` — Check if panel requires PTY process
- Panel Kind Registry (`shared/config/panelKindRegistry.ts`) — config/metadata shared between processes
- Panel Kind Modules (`src/panels/<kind>/`) — per-kind serializer, defaults factory, and component. Unified registry in `src/panels/registry.tsx`

### Multi-Window & Project Views

Each project gets its own `WebContentsView` with an independent V8 context, managed by `ProjectViewManager` (`electron/window/ProjectViewManager.ts`). LRU eviction reclaims views when memory is tight. Per-window services are scoped via `WindowContext.services` (PortalManager, EventBuffer, MessagePorts), while global services (PtyClient, WorkspaceClient) are shared across windows.

### IPC Bridge (`window.electron`)

Access native features via namespaced API in Renderer. 56 namespaces exposed via `contextBridge` in `electron/preload.cts`. Returns Promises or Cleanups. Key namespaces: `worktree`, `terminal`, `files`, `system`, `app`, `project`, `github`, `git`, `portal`, `commands`, `appAgent`, `agentCapabilities`, `mcpServer`, `plugin`.

## Key Features & Implementation

- **Panels:** `PtyManager` (Main) manages node-pty processes. `terminalInstanceService` (Renderer) manages xterm.js instances.
- **Worktrees:** `WorkspaceService` polls git status. `WorktreeMonitor` tracks individual worktrees. Per-view worktree stores backed by dedicated MessagePorts (`WorktreePortBroker`).
- **Agent State:** `AgentStateMachine` tracks idle/working/running/waiting/directing/completed/exited via output heuristics.
- **Context:** `CopyTreeService` generates context for agents, injects into terminals.
- **Actions:** `ActionService` dispatches all UI operations with validation and observability.
- **Resource Profiles:** `ResourceProfileService` adaptively selects Performance/Balanced/Efficiency profiles based on memory pressure, event loop lag, battery state, and worktree count.

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
│   └── handlers/            # 52 top-level + subdirectory handlers (~87 total)
├── lifecycle/               # App lifecycle management
├── setup/                   # App setup/initialization
├── window/                  # Window management (ProjectViewManager, WindowRegistry, multi-window)
├── services/                # ~99 backend services
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
│   └── ...                  # 35 type files total
├── config/                  # panelKindRegistry, agentRegistry, scrollback, devServer, trash, etc.
├── theme/                   # Theme system — 14 built-in themes, palette/semantic/terminal tokens
├── perf/                    # Performance marks
└── utils/                   # Shared utilities

src/
├── panels/                  # Per-kind panel modules (terminal/, agent/, browser/, notes/, dev-preview/)
│   └── registry.tsx         # Unified panel kind registry (components + serializers + defaults)
├── services/
│   ├── ActionService.ts     # Action registry & dispatcher
│   ├── actions/definitions/ # 28 action definition files
│   ├── terminal/            # Terminal instance service
│   └── project/             # Project services
├── components/              # 38 component directories (Terminal, Worktree, Panel, Layout,
│                            #   Settings, Browser, GitHub, DevPreview, Notes, Commands,
│                            #   Portal, Pulse, QuickSwitcher, Onboarding, Notifications, etc.)
├── store/                   # 59 Zustand stores + slices (panelStore, projectStore,
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

Custom Daintree-specific icons live in `src/components/icons/custom/`. Lucide-style SVG components (24x24 viewBox, 2px stroke, round caps/joins, `currentColor`). Brand/agent icons in `src/components/icons/brands/`. Barrel-exported from `src/components/icons/index.ts`.

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
- `docs/plugins/` — Plugin system reference for plugin authors
