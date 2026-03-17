# Changelog

## [0.4.0] - 2026-03-17

### Features

**Digital Ecology Theme Collection**

- 12 new nature-inspired themes: Daintree (default dark), Bondi, Fiordland, Highlands, Arashiyama, Galápagos, Namib, Redwoods, Atacama, Serengeti, Hokkaido, Svalbard (#3299, #3303, #3293, #3294, #3305, #3310, #3312, #3313, #3314, #3315, #3316, #3311)
- Full light-mode support with light-aware token factory and structural color variants (#3271, #3283)
- Terminal color scheme automatically matches the active app theme (#3345)
- Separate dark and light theme sections in the theme picker (#3334)
- Theme redesigns for improved contrast and identity across Arashiyama, Fiordland, Galápagos, Highlands, Namib, Redwoods, Hokkaido, Bondi, Atacama, Serengeti, Svalbard (#3387–#3404)

**Hybrid Input Bar**

- Fuzzy prompt history search with Ctrl+R (#3105)
- @diff, @terminal, and @selection context mentions for inline context bridging (#3158, #3241)
- Image paste and file drag-and-drop support (#3136, #3106)
- Attachment tray with context visibility (#3137)
- Pop-out expanded editor (#3104)
- Input stash — saves and restores draft text on context switch (#3090)
- Slash command support mid-text (#3085)
- URL paste detection with opt-in content resolution (#3089)

**Workflow Engine**

- Workflow execution status panel (#3248)
- Approval gate node for human-in-the-loop workflows (#3242)
- Loop node for bounded retry patterns (#3249)
- Typed data flow between workflow nodes (#3240)
- IPC bridge exposing WorkflowEngine to the renderer (#3239)

**Agent System**

- Directing state — detects when user is actively typing into a waiting terminal (#3140)
- Cursor CLI added as a supported agent (#3038)
- Resume agent sessions from stored session IDs (#3040)
- Gemini CLI window title used as structured state signal (#3201)
- Proactive per-process memory monitoring (#3237)
- Escalate waiting agent to OS notification after inactivity threshold (#3037)
- Re-entry summary notification when returning after background agent activity (#3099)
- Derive all agent references from central registry (#3178)
- Discover Claude Code skills as slash commands automatically (#3084)

**Settings & Preferences**

- Environment Variables tab (#3279)
- Privacy & Data tab (#3289)
- Sub-tab navigation for General and Panel Grid tabs (#3269, #3268)
- Appearance split into App and Terminal subtabs (#3329)
- Per-setting modified indicators with inline reset (#2931)
- Fuzzy search with @modified filter (#2923)
- Contextual entry points from the main UI (#2950)
- Searchable dropdown selector for CLI Agents (#3284)

**GitHub Integration**

- Redesigned issue and PR list items for better information density (#3095)
- Unified visual language across Issues, PR, and Commit dropdowns (#3234)
- Sort order controls with filter popover (#3330, #3342)
- CI status indicator on PR list items (#3063)
- Keyboard navigation in issue, PR, and commit dropdowns (#2989)
- Clickable issue/PR titles and linked PR refs (#3170)
- Indicate existing worktrees in the issue/PR dropdown (#2981)

**Per-Project Configuration**

- Per-project MCP server configuration (#3267)
- Per-project AI agent instructions (#3244)
- Per-project terminal shell and scrollback settings (#3247)
- Per-project worktree path pattern override (#3245)
- Per-project notification preference overrides (#3288)

**Worktree & Sidebar**

- Lifecycle stage indicator on worktree card header (#2832)
- Card-level visual treatment for waiting agent state (#2859)
- Worktree count badge in sidebar header (#2856)
- 4 priority-ordered state chips (#2959)
- Recipe-first quick worktree creation flow (#3045)
- Running QuickRun tasks shown with status in sidebar (#3098)

**Panel & Layout**

- Promote Move to Dock to visible header button (#3134)
- Background panel location for running tasks without visible panels (#3061)
- Macro-region focus cycling with F6/Shift+F6 (#3153)
- Trash icon pulse animation replacing close-panel toast (#3138)
- Keyboard access to panel context menus via Shift+F10 (#2951)

**Terminal Rendering**

- WebGL renderer for focused terminal (#3213)
- Tiered WebGL context leasing system (#3223)
- Renderer micro-optimizations: font preloading, cursor blur, offscreen visibility (#3139)
- Stagger terminal spawning during session restore (#3130)
- Evict orphaned restore session files on startup (#3187)

**Notifications**

- Action buttons on notification history entries (#2831)
- Improved notification center with read management and filtering (#2980)
- Coalesce rapid agent notifications into a single updating toast (#2982)
- Reduce notification noise for user-initiated actions (#3126)

**Notes**

- Markdown preview with Edit/Split/Preview toggle (#2830)
- Markdown formatting toolbar (#2922)
- Tag filtering and sort options (#2948)

**Onboarding**

- Unified resumable onboarding state machine (#2836)
- Getting-started checklist after setup wizard (#2952)
- Progress indicator between steps (#3450)

**Browser & Dev Preview**

- URL history autocomplete in address bar (#2835)
- Find-in-page (Cmd+F) in browser and dev-preview panels (#2949)
- CDP-based object inspection and stack traces in console panel (#2955)

**Accessibility**

- Color vision mode for colorblind accessibility (#3042)
- Screen reader announcements for drag-and-drop and status changes (#2945)
- Toolbar arrow key navigation with ARIA roles (#2921)

**Voice Input**

- Word-level confidence scoring for selective LLM correction (#2834, #2876)
- Dynamic project context injection into Deepgram keyterms (#2837)

**Other**

- Node.js compile cache for faster cold start (#3447)
- Demonstration mode for scripted video production (#2973)
- QuickRun Justfile and Taskfile.yml task detection (#2998)
- Arch-specific macOS builds alongside universal (#2958)

### Bug Fixes

- Fix terminal scrollback lost when hibernation kills processes (#3177)
- Fix scroll position jumping during wake-restore cycle (#3103)
- Fix new terminals not respecting selected color scheme (#3343)
- Fix terminal wrapper background bleed with active color scheme (#3328)
- Fix mouse/focus events falsely triggering directing state (#3325)
- Fix stacked restart indicators in terminal panels (#3463)
- Skip WebGL renderer on software-only GPU (#3362)
- Reduce WebGL context pool to stay under Chromium limit (#3358)
- Fix directing/waiting jitter on prompt submission (#3224)
- Allow user input to recover agent from failed state (#3195)
- Persist and restore agent launch flags on session resume (#3175)
- Filter cosmetic terminal redraws from activity tracking (#3200)
- Fix CPU% always reporting 0 on Windows (#3407)
- Fix panel position/size swap on project switch (#3424)
- Fix tab bar overflow — add indicators and active tab auto-scroll (#3465)
- Fix dock popover dismissing on outside click and header button interactions (#3133, #3125)
- Fix stale GitHub metadata in worktree sidebar (#3333)
- Fix PR list failing with GraphQL type mismatch on sort (#3339)
- Fix GitHub dropdown timeout — replace 90s wait with immediate reset on close (#3220)
- Fix worktree sidebar search for text and bare number queries (#3423)
- Remove spurious self-assign notification on worktree creation (#3446)
- Fix orphaned PTY process trees on Windows via taskkill /T (#3322)
- Make lifecycle service cross-platform — replace Unix-only process group kill (#3323)
- Expand Windows Git PATH discovery for x86, Scoop, and Chocolatey (#3425)
- Use native title bar on Linux (#3321)
- Fix background color flash on startup with light themes (#3461)
- Fix OpenCode TUI blank screen caused by CI env var poisoning (#3417)
- Discard orphaned dev-mode crash markers on startup (#3405)
- Cap concurrent toast display at 3 with overflow displacement (#3458)
- Replace emoji icons in error UI with Lucide SVGs for cross-platform consistency (#3449)
- Block browser-default file navigation on non-terminal drop (#3448)
- Fix default scrollback from 5000 to 1000 lines (#3172, #3365)
- Clear stale terminal state maps on panel removal (#3173)
- Show only user-selected agents in toolbar (#3210)
- Deep-link toolbar agent button to agent settings subtab (#3331)
- Show keyboard shortcut hints in all toolbar tooltips (#3462)

### Performance

- Graduated memory pressure mitigation — auto-reduce scrollback and hibernate idle terminals (#3366)
- Skip terminal wake cycle for warm terminals during project switch (#3235)
- Concurrent non-PTY panel restoration during hydration (#3199)
- Reduce reconnect fallback timeout from 10s to 2s (#3191)
- Tune Vite build target for Electron 40 / Chromium 144 (#3486)

### Other Changes

- Migrate from Vite 6 to Vite 8 with Rolldown bundler (#3490)
- Upgrade ESLint from v9 to v10 (#3489)
- Bump node-pty to 1.2.0-beta.12 (#3477)
- Strip debug console statements from production builds (#3452)
- 19 new E2E test suites covering action palette, terminal search, worktree interactions, crash recovery, accessibility, and more
- Major refactoring: decompose main.ts, WorkspaceService, ProjectStore, TerminalProcess, HybridInputBar, and 10+ other modules into focused collaborators

---

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
