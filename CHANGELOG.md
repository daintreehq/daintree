# Changelog

## [0.5.0] - 2026-03-26

### Features

**Theme System Overhaul**

- 14 built-in themes with redesigned semantic token system, palette variables, and component overrides (#3992, #3993, #3994)
- Ecosystem imagery theme picker with animated selection (#4042)
- Bondi redesigned as premium warm light theme (#3993)
- Recipe tokens for pulse, heatmap, settings, toolbar, sidebar, and worktree sections

**Memory & Resource Management**

- 3-tier progressive panel limit system to prevent grid overload (#4135)
- Destroy hidden webviews under memory pressure (#4202)
- Lazy-load webviews for browser and dev-preview panels (#4198)
- Dispose xterm.js instances for background-tier terminals (#4200)
- LRU eviction for background Portal (formerly Sidecar) tabs (#4197)
- Per-terminal process resource monitoring with CPU and memory (#4149)
- Replace hardcoded memory estimate with real app.getAppMetrics() (#4219)
- Bridge PTY host ResourceGovernor signals to main process (#4203)
- FD monitoring to detect node-pty leaks on Linux (#4180)
- Reclaim renderer memory on minimize and memory pressure

**Agent Intelligence**

- Surface approval-waiting state with differentiated UI treatment (#3940)
- Classify waiting state reason as prompt, approval, or question (#3939)
- Universal approval prompt hint patterns for all agents (#3937)
- Prompt lexeme fallback heuristic for generic prompt detection (#3938)
- Two-phase directing state timeout
- Immediately transition to working on Enter press

**Bulk Operations**

- Bulk command center palette for multi-worktree operations (#3956, #3958)
- State filtering, templates, and recipe broadcasting (#3960)
- Per-item status tracking, error display, and retry for bulk worktree creation (#3950)
- Emergency bulk agent interrupt with sidebar button (#3955)

**Terminal Improvements**

- Route PTY output over direct MessagePort for lower latency
- Synchronized output wrapping with DEC Mode 2026
- "New output below" scroll indicator (#3815)
- Scroll-to-last-activity action
- Send-to-agent action for terminal selection
- Shell init noise suppression in agent terminals (#4205)
- Manual PTY host restart after auto-recovery exhausted
- PTY diagnostic fields in Terminal Info dialog

**Worktree UX**

- Live drag-to-reorder with persistent manual sort order and DragOverlay preview
- Collapsible worktree cards
- Quick state filter bar with counts above worktree list (#3936, #4231)
- Needs Attention triage section in sidebar
- Session state indicators on collapsed cards (#3975)
- Copy Path and Copy Context progress feedback in 3-dot menu (#4137, #4138)
- Improved root worktree display for non-standard branches (#4055)

**UI Polish**

- Custom Canopy icon set replacing cube logomark with tree mark
- Toolbar responsive design with priority-based overflow (#4133)
- Panel tab scroll arrow buttons for overflow
- Spring easing curves for palette and modal animations (#3818)
- Global Escape key LIFO stack for layered UI dismissal (#3813)
- Contextual shortcut hints replacing passive toasts
- Actionable CTAs in palette empty states (#3814)
- Double-click hint in maximize/restore tooltips
- Layout undo/redo for panel drag-and-drop operations

**GitHub Integration**

- Issue bulk actions with multi-select and floating action bar (#3960)
- Project health signals via GraphQL API
- Comment count in issue and PR list items
- Multi-number and range syntax in issue/PR search
- Select All and Select Unassigned buttons
- Cached issues/PRs shown instantly in toolbar dropdown

**Onboarding & Welcome**

- Theme selection as first onboarding step
- Rich Welcome View replacing minimal welcome screen
- Getting started checklist steps as clickable CTAs
- Celebration UX when checklist completes
- Simplified theme step to Daintree vs Bondi choice (#3996)

**Other**

- Global dev server detection and toolbar integration
- Project groups in project switcher palette
- Per-panel model selection with two-phase UI
- Portal rename (formerly Sidecar) across codebase (#3947)
- Auto-save project settings replacing Cancel/Save bar (#4069)
- Master toggle to disable notifications and hide bell icon (#4085)
- Settings tab memory within session (#4066)
- Demo recording infrastructure with ffmpeg encoding
- Multi-window foundation with WindowRegistry
- Startup skeleton UI shell to eliminate blank window flash

### Bug Fixes

- Fix agent state falsely transitioning to working on layout shifts (#4225)
- Fix commit textarea focus loss during re-renders (#4218)
- Fix 'external diff died' from broken diff.external override (#4214)
- Fix agent launch flags lost during crash recovery (#4215)
- Fix auto-updater errors on Linux .deb installs -- missing APPIMAGE check (#4179)
- Fix PTY pool overriding user's locale to en_US.UTF-8 (#4178)
- Fix Windows node-pty build requiring Spectre-mitigated libraries (#4145)
- Fix cross-platform path handling in EditorService tests (#4146)
- Fix changed file text turning gray on sidebar hover (#4147)
- Fix GitHub token error not linking to settings (#4148)
- Fix truncated file names in git staging window (#4154)
- Fix Bulk Command Center crash from maximum update depth exceeded (#4132)
- Fix commits dropdown ignoring selected worktree branch (#4056)
- Fix duplicate terminal tab issue (#4050)
- Fix layout issue with maximize feature (#4049)
- Fix Gemini CLI connection issues (#4048)
- Fix sessionPersistTimer causing serialization error on PTY exit (#4047)
- Fix unhandled promise rejection in PortalManager.navigate() (#4046)
- Fix View/Diff toggle not switching to View mode (#4045)
- Fix agent failed state unreliability -- remove failed state detection (#4043, #4037)
- Fix main worktree cards showing branch name instead of project name (#3789)
- Fix removeProject() orphaning PTY processes (#3788)
- Fix worktree deletion failures (#3946)
- Fix pasted URLs highlighted due to dual link handling (#3948)
- Fix agent viewport intermittently jumping to top (#3949)
- Fix URLs not clickable after WebLinksAddon removal (#3820)
- Fix worktree card click targets making selection difficult (#3809)
- Fix renderer cleanup gaps for inputControllers and SemanticAnalysisService (#3835)
- Fix PTY host cleanup not releasing SharedArrayBuffer references (#3839)
- Fix issue icon checkbox hover target (#3918)
- Fix project keybinding broken by group add/remove (#4117)
- Fix Daintree settings sidebar background color (#4075)
- Fix Pulse differentiating 'no internet' from 'no GitHub remote' (#4093)
- Fix dev preview slow start detection causing unnecessary restart (#4087)
- Fix "Loading agent status..." in dev mode (#4083)
- Fix bulk worktree creation running twice (#4011)
- Fix non-user-invocable slash commands appearing in hybrid input (#4181)
- Strip ELECTRON_RUN_AS_NODE from spawned environments (#4176)
- Reduce 2-panel split divider width from 12px to 6px (#4086)
- Remove Pulse current-day highlight ring, show commit count (#4082)
- Remove empty-state recipe buttons (#4079)
- Remove built-in Canopy commands and Agent Instructions (#4100)

### Security

- Harden simple-git against malicious repo config RCE
- Harden webview CSP with form-action directive
- Validate webContentsId ownership in CDP handlers
- Kill entire process tree on terminal close and app quit
- Add fetch timeouts to GitHub API and Git operations
- Global error handlers with crash logging and relaunch
- Unhandled promise rejection handler in renderer

### Accessibility

- Screen reader support for terminals
- Forced-colors CSS and form error linking
- axe-core coverage in E2E tests

### Performance

- React.lazy code splitting for heavy panel components
- V8 bytecode caching for faster startup
- React.memo on GridTabGroup, GridPanel, ActionPaletteItem, QuickSwitcherItem
- useDeferredValue for worktree list, event log, and palette search
- CSS containment on panel and terminal containers
- Memoize worktree data, selectors, and GitService instances
- Preserve object identity in store updates to reduce re-renders
- Replace requestIdleCallback with scheduler.postTask
- Event loop lag and long task monitoring
- CI optimizations: parallel build, reduced runner costs

### E2E Testing

- ~50 new E2E test suites covering terminals, worktrees, panels, crash recovery, accessibility, keyboard navigation, settings, onboarding, notes, portal, drag-and-drop, context injection, and more
- Shared focus assertion helpers and workflow step library
- PTY stress test helper infrastructure
- IPC fault injection infrastructure for error testing
- Single-file E2E test trigger in CI workflow (#3917)
- Nightly memory leak detection tests

---

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
