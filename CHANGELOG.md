# Changelog

## [0.3.0] - 2026-03-11

### Features

- **Worktree Sidebar Redesign** — Visual hierarchy polish, unified search+filter input, persistent inline search bar, and header cleanup (#2756, #2758, #2747)
- **Voice Input Improvements** — Upgrade to GPT-5 Mini correction model, stable ID-based correction matching, canonical phase model, paragraphing strategy with spoken-command default, and distinct interim vs pending-AI visual treatment (#2754, #2694, #2692, #2697, #2695)
- **SQLite Project Registry** — Migrate project registry from electron-store JSON to SQLite for durability (#2707)
- **Project Relocation** — Relocate projects with automatic state and environment variable migration (#2688)
- **Check for Updates** — Add menu item to manually check for application updates (#2685)
- **File Viewer Images** — Display image files inline in the file viewer instead of showing binary error (#2739)
- **Settings Subtabs** — Formal subtab support for settings pages, CLI Agents tab restructured with subtabs and canonical default agent (#2698, #2699)
- **Review Hub Enhancements** — Surface PR state with clickable link, add base-branch diff toggle for PR-accurate review (#2684, #2683)
- **GitHub Issue Selector** — Show author and comment count in issue selector rows (#2690)

### Bug Fixes

- Fix cross-project contamination in worktree snapshot cache and refresh (#2741, #2703)
- Fix crash recovery destroying project list on Start Fresh (#2704)
- Exclude projects from crash recovery session snapshot (#2706)
- Fix dev mode triggering crash recovery dialog on every restart (#2705)
- Fix Cmd+W not closing the focused panel (#2689)
- Fix input field intermittently dropping text on submit (#2737)
- Fix Enter during voice dictation corrupting paragraph boundaries (#2693)
- Replace aggressive GitHub error box with stale data banner (#2740)
- Add actionable link to GitHub settings on token configuration error (#2738)
- Replace AI correction badge with green dotted underline decoration (#2755)
- Anchor plus button to right edge of worktrees header (#2765)
- Remove root worktree background tint collision with active selection (#2766)
- Remove inline Copy Context button and Inject Context menu item (#2763)
- Reduce noisy success toasts for user-initiated actions (#2752)
- Remove hardcoded onboarding wizard prompt sent to agent (#2700)
- Restore primary button text contrast (#2682)
- Hide Check for Updates menu item in development mode (#2753)
- Handle renamed or deleted project directories gracefully (#2686)

### Performance

- Throttle inactive dock webviews via CDP lifecycle freeze (#2702)
- Reduce renderer render churn from high-frequency store updates (#2701)

---

## [0.2.0] - 2026-03-09

### Features

- **Voice Input** — Real-time voice transcription via Deepgram Nova-3 with AI text correction, paragraph boundary detection, persistent dictation across navigation, and Escape-to-cancel (#2680, #2672, #2559, #2558)
- **MCP Server** — Expose action system as local MCP server with port config, auth, and settings UI (#2533)
- **Crash Recovery** — Recovery dialog with diagnostics, restore options, and hydration race protection (#2551)
- **Review Hub** — In-app git staging, commit, and push with auto-resync on git status changes (#2576)
- **Notification System** — Unified notify() API with priority-based routing, toast redesign, notification center dropdown, and agent completion sounds (#2541, #2670, #2671)
- **Settings Overhaul** — Searchable settings, consistent card layout, icons, improved keyboard UX, and modified indicators (#2553)
- **Theme System** — Semantic color tokens, editor/terminal theme subsystems, color scheme selection, brand accent shift to muted blue (#2595, #2539)
- **SQLite Persistence** — Migrate tasks and workflow runs from JSON to SQLite for improved reliability
- **Worktree Enhancements** — Lifecycle scripts (.canopy/config.json), cross-worktree diff comparison, configurable branch prefix, create worktree from PR action (#2530, #2641)
- **Editor Integration** — Configurable open-in-editor with first-class editor support
- **In-Repo Settings** — Read and write .canopy/project.json for portable project identity (#2526)
- **Terminal Watch** — One-shot terminal watch notifications and browser console capture with screenshots (#2539, #2557)
- **Keybinding Profiles** — Import/export keyboard shortcut profiles
- **Onboarding** — System health check during first-run setup
- **Telemetry** — Opt-in crash reporting with Sentry
- **Security** — Environment variable filter for terminal spawning

### Bug Fixes

- Fix layout corruption when adding third panel in two-pane split mode (#2638)
- Voice recording no longer stops when Canopy loses window focus (#2666)
- Fix toolbar project-switcher collision with CSS grid layout (#2584)
- Reliably switch renderer to newly created worktree (#2571)
- Fix hydration race conditions and false positive crash detection
- Upgrade node-pty to 1.2.0-beta.11 to fix Windows build (#2646)
- Fix toaster infinite re-render loop with useShallow
- Hide closed PRs from worktree card header badges (#2578)
- Fix root worktree toggle behavior and label clarity
- Standardize toolbar interactive state colors to shared token set (#2585)
- Fix notification badge over-counting with seenAsToast tracking (#2670)
- Fix text selection visibility in dark theme (#2617)
- Replace native Electron context menus with Radix UI for consistency
- Harden mic permission detection across all platforms

### Other Changes

- Migrate raw Tailwind color utilities to semantic design tokens
- Unify all settings tabs to consistent card layout
- Extensive test coverage additions across MCP, voice, persistence, and workspace modules

---

## [0.1.0] - 2026-02-26

### Highlights

Initial public release of Canopy Command Center — an Electron-based IDE for orchestrating AI coding agents.

### Core Features

- **Terminal Grid** — Multi-panel terminal layout with xterm.js v6, split panes, dock, and drag-and-drop reordering
- **Agent Orchestration** — First-class support for Claude, Gemini, and Codex agents with state detection (idle/working/waiting/completed)
- **Worktree Dashboard** — Visual git worktree management with real-time status, mood indicators, and file watching
- **Context Injection** — CopyTree integration for generating and injecting project context into agent terminals
- **Action System** — Unified dispatch layer for menus, keybindings, context menus, and agent automation (17 action categories)
- **Browser Panels** — Embedded browser with dev preview for local development servers
- **Multi-Project Support** — Fast project switching with optimistic UI updates and per-project state persistence
- **GitHub Integration** — Issue and PR status in toolbar, worktree linking to issues

### Security

- Hardened Electron runtime with sandbox and permission controls
- Electron fuses enabled, code signing enforced (macOS)
- Content Security Policy across all sessions
- IPC rate limiting and error sanitization

### Performance

- Non-blocking project switching with parallelized hydration
- Stale-while-revalidate caching for worktree snapshots
- Terminal container optimized for xterm v6 overlay scrollbar
- Adaptive polling with circuit breaker resilience
