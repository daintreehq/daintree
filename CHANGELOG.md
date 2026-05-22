# Changelog

## [0.12.1] - 2026-05-22

Patch release closing six issues found in 0.12.0 — the file diff viewer always failed to load, the workspace sidebar hung when a project folder was missing, and the Daintree Assistant silently dropped an unsupported saved agent preference. Also lands faster panel closing plus fleet-scope and picker-footer polish.

### Bug Fixes

- Daintree Assistant now explains when a saved preferred agent is unavailable instead of silently falling back to none (#8775)
- File diff viewer no longer fails with "Failed to load diff" (#8800)
- Workspace sidebar no longer hangs when a project folder no longer exists (#8796)
- Fleet broadcast no longer auto-enters fleet scope on raw input (#8797)
- Decluttered the footer in the cold-start arm-terminals picker (#8802)
- Removed the accent color from the sidebar arm-matching button
- Grid terminals now fit synchronously to avoid a layout flash on open

### Performance

- Closing a grid panel now feels instant — the panel hides immediately while teardown runs deferred and coalesced
- Chunked the terminal resize pass to prevent a renderer freeze when closing panels with Cmd+W

## [0.12.0] - 2026-05-21

A large release centered on cold-start and memory — the boot path was instrumented end to end and trimmed, and the memory-pressure mitigation ladder is now closed-loop. Fleet broadcast, crash recovery, and the worktree sidebar were each substantially reworked; forge integration was generalized off GitHub into a provider model, and the MCP server gained audit tooling and abuse caps.

### Features

**Forge & plugins**

- Forge provider model — remote-URL routing selects the active provider, with global default and per-project override settings (#8057, #8110, #8111, #8112)
- Plugins can register forge providers and contribute per-file forge badges via a file-decoration API (#8058, #8511)
- Unified Code Forge settings tab replaces the separate GitHub and Forge tabs, with real per-provider settings and auth surfaces (#8329, #8330, #8454, #8525)
- Preferences gained a Forge Integrations section (#8064)
- Commit-author avatars now resolve through a forge-agnostic provider system (#8514)

**Fleet broadcast**

- Per-target edit and skip in the broadcast popover (#8691)
- Fuzzy matching replaces substring/regex in the fleet picker (#8695)
- Cold-start fleet picker can toggle replace vs append (#8694)
- Broadcasts confirm on the resolved fan-out rather than the source draft (#8689)
- Saved fleets split into Pinned and Smart-Sets sections, with frecency ranking (#8692, #8693)
- Fleet preset menu items show armed panel count and dim unmatched panes on hover (#8688, #8696)

**Worktree sidebar & overview**

- Virtualized worktree sidebar with keyboard-accessible windowing (#8393)
- Worktree rows show blocking git states, dirty status, last commit author and time, base-branch divergence, and fetch staleness (#8380, #8381, #8382, #8483, #8484, #8485)
- Row badges are ordered by salience and surface alarms when the sidebar is collapsed (#8379, #8763)
- Worktrees overview gained multi-select, keyboard navigation, clickable aggregate stats, and bulk close/remove (#8385, #8653, #8655, #8766)
- Worktree filter chip counts switched to disjunctive faceting (#8390)
- Placeholder card renders while a worktree is being created; delete progress shows on the card (#8414, #8417)
- Sidebar surfaces filter scope, drag-disabled reasons, and a disabled drag handle when reorder is unavailable (#8391, #8395)
- Worktree lifecycle failures are now recoverable from the card (#8401)

**Terminal**

- Terminal search gained an overview ruler, regex error surface, whole-word toggle, and search history recall (#8532, #8539)
- Hibernated terminals are surfaced in pane chrome with a new Sleep action; hibernation is idle-aware and memory-pressure adaptive (#8534, #8536)
- Double-click a panel title to maximize it (#8707)
- Last-active panel per worktree is prioritized on restore (#8703)
- Terminal dock actions are exposed to the Daintree Assistant (#8594)

**Dev preview**

- Dev preview toolbar reaches parity with the browser pane — screenshot, devtools, console capture, rotation, DPR, and zoom-to-fit (#8262, #8268, #8279)
- Viewport presets use full device emulation instead of a user-agent swap (#8278)
- Staged stuck-start UX replaces silent auto-restart, with tiered restart vocabulary and an explicit Stop control (#8275, #8276, #8277)
- Empty state shows detection preview and a runner picker; blocked-navigation banner was rebuilt (#8263, #8267)
- Broader run-command detection with Procfile/mise.toml support and pre-launch port extraction (#8266)

**MCP server & assistant**

- MCP audit settings with filters, search, NDJSON export, and latency SLO bands (#8437)
- Audit records correlate to assistant turns; a turn-outcome diagnostics view and in-process anomaly detector surface operator signals (#8430, #8433, #8438)
- Progressive tool disclosure in the MCP manifest (#8459)
- Time-bounded per-tool grants replace sticky tier elevation, with an abuse cap on repeated auth failures (#8442, #8467)
- HybridInputBar is wired into the Daintree Assistant (#8185)
- Runaway-loop protection rate-limits the CallTool path (#8468)

**Crash recovery & safe mode**

- Crash recovery defaults to silent restore with a clearer opt-in (#8677)
- Safe mode quarantines repeat-suspect panels instead of dropping all panels; suspect panels are surfaced more visibly (#8679, #8704)
- Watchdog-disabled state now shows a recovery banner (#8674)

**Toolbar & dock**

- Right-click "Unpin from toolbar" works across all live toolbar buttons; plugin buttons render as hideable rows in settings (#8182, #8183)
- Keyboard navigation added to the dock chip rail (#8170)
- Voice recording stays pinned out of toolbar overflow while actively recording (#8158)
- "Copy path" surfaces in the modal and toolbar project pickers (#8222)

**Settings**

- Settings tab content prefetches on hover/focus (#8760)
- Cross-scope settings search merged with a per-row scope chip (#8235)
- Unified override-vs-inherit UI across project-settings tabs (#8238)
- Default worktree recipe selector moved onto the Recipes tab as a per-row pin (#8233)

**Other**

- Cross-project shortcut to focus the next waiting agent (#8418)
- Destructive confirms wired across terminal, session, and remaining direct-IPC bypass sites (#8242, #8245)
- No-worktree main-canvas empty state was reworked (#8645)

### Bug Fixes

**Fleet broadcast**

- Progress counter no longer hidden for small fleets; counter is duration-gated (#8686)
- Cancel announcement now includes the skipped count (#8687)
- Targets no longer left armed on ENOTCONN/ENXIO/EINVAL; dead PTYs auto-disarm on structured broadcast (#8690, #8706)
- Retry no longer fires empty writes; partial failures surface inline (#8705)
- Raw broadcast no longer leaves a stuck directing state or writes to hidden cross-worktree terminals (#8255)

**Worktree**

- Worktrees no longer marked finished while an agent is still working (#8223)
- Phantom sidebar rows clear after an external worktree removal (#8510)
- External worktree removes are no longer swallowed by the topology suppress window (#8412)
- Watcher degradation now has a persistent indicator and recovery path (#8413)
- Worktree-load failures surface instead of triggering a partial switch rollback (#8400)
- Teardown phase status is no longer overwritten when the next phase starts (#8406)
- "All caught up" no longer shown for empty worktree filters (#8650, #8745)
- Clone-into-project flow tightened, with a GitHub-aware recovery action on auth failure (#8408, #8411)
- Sidebar zero-result empty states now have a path back to the overview (#8383)
- In-flight worktree delete mutations recover across host crashes (#8405)

**Terminal**

- Focus no longer jumps from xterm back to the hybrid input on agent panes (#8487)
- Unfocused terminal panes no longer swallow shift+click or leak drag events (#8531)
- Scrollback restore failures surface as an inline warning instead of failing silently (#8535)
- Visible terminals fully refresh on project switch-back (#8562)
- Stale panel chrome from memo comparator drift fixed (#8588)
- Per-pane terminal banners are suppressed while the PTY host is down (#8676)
- Agent state detection no longer depends on terminal panel size (#8701)
- Panel grid no longer shrinks agent terminals below a usable size (#8702)
- ResourceGovernor no longer flaps between pause and force-resume under load (#8616)

**Crash recovery & safe mode**

- GPU crash monitor hardened against no-op restarts and non-atomic flag writes (#8671)
- Main-process watchdog hardened against false-positive SIGKILLs and slow-leak crash loops (#8672)
- Slow-flap blind spot closed in the crash-loop guard decay window (#8683)
- Corrupt crash-loop state is quarantined and stale temp files are swept (#8684)
- Global recovery banners coordinate with stacked precedence (#8678)
- GPU ANGLE fallback state now has a UI signal (#8673)
- Emergency recovery reset and crash-recovery reset are gated behind a confirm with preview (#8675, #8697)
- SafeModeBanner restart elevated to a destructive confirm with a View logs action (#8685)

**Dev preview**

- Dev preview joins project URL history and preserves its route on restart (#8273)
- render-process-gone and unresponsive states surface as inline banners (#8270)
- Scroll position is preserved when eviction follows a freeze (#8281)

**Cold-start & windows**

- Cold project switch no longer flashes on paint-gate timeout (#8606)
- Background throttling now applies to cached project views (#8599)
- Primary window tracks the active window rather than registration order (#8600)
- Global services stay alive across last-window-close, closing a re-init race (#8604)
- ResourceProfileService memory controls reach every window (#8605)
- Event-loop-lag detector no longer gets stuck in efficiency mode (#8615)

**MCP server & assistant**

- Daintree Assistant agent can be switched while a Codex session is bound (#8353)
- Codex assistant no longer tells users to switch to Claude despite having Daintree MCP wired (#8354)
- MCP dispatch no longer ignores the contextOverride field (#8317)
- MCP dedup no longer returns a cached result when a requestKey collides with new args (#8429)
- MCP session idle timer survives laptop suspend/resume (#8466)
- Help-session MCP dispatch no longer silently targets the wrong worktree (#8432)
- Daintree Assistant allowlist broadened for forge CLI commands (#8360)

**UI & toolbar**

- Toolbar roving-tabindex fixed under overflow and portal menus (#8163)
- Toolbar overflow no longer oscillates at boundary item widths (#8157)
- Dock shadow now visible on light themes (#8156)
- Dock popover stays open while typing into the agent input (#8368)
- Warm-cache flash on the Avatar and ProjectSwitcher trigger eliminated (#8244)
- Dismiss button no longer floats mid-banner in the panel-count warning (#8291)
- Open-in-grid button no longer overlaps the status indicator in docked agent panels (#8359)
- Non-launchable agents no longer dead-end in the dock launch menu (#8155)
- Attach Issue picker no longer shows stale or mislabeled search results (#8647)
- Project switcher MRU ordering targets the correct project (#8561)

**Settings & infrastructure**

- Env var editor no longer describes plaintext storage as "securely stored" (#8234)
- Invalid worktree path pattern no longer aborts auto-save of unrelated fields (#8236)
- Workspace host no longer respawns forever in a crash-ready loop (#8553)
- Worktree MessagePort transport hardened against silent failures (#8551)
- GitOperationError metadata is preserved across the contextBridge boundary (#8567)

### Performance

**Cold-start & memory**

- Cold-start IPC fan-out collapsed into a single batched boot invoke (#8620)
- Independent hydration steps run concurrently to cut serial IPC round-trips (#8619)
- Two blocking steps trimmed from the cold-start critical path (#8622)
- Synchronous shell spawn no longer blocks main-process startup (#8625)
- First React render no longer blocked by Sentry initialization (#8632)
- ActionService defers JSON Schema compilation to first use instead of compiling all schemas at cold start (#8614)
- app:// handler sends caching headers so the V8 code cache persists across launches (#8624)
- Renderer first-render import closure trimmed and the monolithic App.tsx chunk split (#8626, #8627)
- ProcessMemoryMonitor pressure thresholds scale with device RAM (#8633)
- Memory-pressure mitigation ladder is now closed-loop (#8634)

**Project views**

- Project-view eviction switched to pure LRU, targeting the least-used renderer (#8602)
- Efficiency profile no longer discards cached views without memory pressure (#8603)

**Rendering & multi-agent load**

- Agent-status and panel-store writes batched into one write per frame (#8589, #8592)
- GridPanel restructured to id-based store subscriptions; useContentGridContext subscription narrowed to stop per-agent re-renders (#8591, #8593)
- Panel grid resize batches reflows one frame at a time (#8597)
- Terminal refresh-tier classification is now fleet-aware (#8596)
- Agent terminals no longer flash when 20+ are visible (#8378)
- Renderer stops writing to xterm after a panel backgrounds (#8365)
- WebGL context cap and resource-profile ceilings raised; the circuit breaker coalesces memory-pressure context-loss bursts (#8540, #8541)
- ResourceProfileService reacts to many-agent fleet load (#8623)
- Per-row sidebar subscriptions stop full-list re-renders on each poll (#8389)

**Forge & git**

- PR detection batches lookups via a forge findPRsByBranches capability (#8384)
- Idle git-status cost cut in WorktreeMonitor (#8396)
- GitHub rate-limit throttling is now adaptive and budget-aware; wasteful polling in stats and health queries was cut (#8756, #8757)
- PortBatcher no longer allocates a fresh buffer on every flush (#8367)

## [0.11.1] - 2026-05-17

Stability follow-up to v0.11.0. Walks back two terminal rendering regressions, refreshes project stats on trash and restore without waiting for the 5s poll, and lets the Daintree Assistant resume across project-view LRU eviction. The release pipeline also splits into three independent per-OS workflows.

### Features

- Daintree Assistant survives project-view LRU eviction via PendingHelpHibernationStore — agent resume tokens are flushed before revocation and reclaimed on next open

### Bug Fixes

- Restore VISIBLE-tier WebGL eligibility for agent panes — fixes warped block / box-drawing glyphs (U+2584 and friends) on unfocused tiled fleet panes, walking back the focused-only mitigation
- Revert the 32 KiB terminal write slicer — restores correct backpressure ACK accounting and in-order writes (the slicer's batch fan-out broke `acknowledgePortData`)
- ProjectStatsService subscribes to `terminal:trashed` and `terminal:restored` so stats recompute on the next debounce window instead of waiting up to 5s
- Replace the Eclipse icon with Moon in BackgroundContainer

### Other Changes

- Release pipeline split into three per-OS workflows (release-macos.yml, release-linux.yml, release-windows.yml) — each OS publishes independently the moment its own pipeline goes green (#8052)
- Full-\* E2E buckets shard 4-way to cut serial Windows wall-time from ~39min to ~10min (#8053)
- Drop screenshot rendering from gating CI (#8054)
- Windows smoke timeouts and per-run retry support
- E2E concurrency scoped per platform so the per-OS release workflows don't cancel each other
- Poll-guard the duplicate-tab assertion in `core-terminal-panels` to stabilise it under shard 2/4 timing
- Remove dead ProjectMruSwitcherOverlay component

## [0.11.0] - 2026-05-16

Windows reaches feature parity with macOS and Linux — NSIS and Store builds, native menu/keybinding gaps closed, UTF-8 in fallback shells, agent command-launch parity. Alongside the Windows push: a deeper resilience pass on pty-host, watchers, and crash recovery; destructive-action confirms widened to every remote push; the banner family converges on shared chrome; and another EmptyState / skeleton sweep removes the last full-area Spinners.

### Features

**Windows**

- Non-Store NSIS installer with arm64 support (#7942)
- In-app update notification for Windows Store builds (#7980)
- Native application menu gaps closed (#7939)
- Ctrl+F4 close-tab and Menu key context-menu shortcuts (#7943)
- Agent command-launch parity with POSIX (#7945)
- Dedicated scratch folder for the Daintree Assistant (#7947)

**Sidebar & drag/drop**

- Sortable sidebar row directional drop indicator and Alt+Arrow keyboard reorder (#7972)
- canScroll and per-surface ARIA announcements on nested DndContexts (#8016)
- Alt+Arrow worktree-name announcement and debounce for screen readers (#8013)
- Snap-back motion on Escape-cancelled drags (#8019)
- Trash hint repetition capped, popover flipped to LIFO (#7977)
- Complete drop-armed visual on dock receptacles (#7978)

**Destructive actions**

- Commit-and-push confirm gate widened to every remote push (#8025)
- Missing D1–D3 confirm dialogs wired across UI surfaces (#8023)
- MCP rotate confirm tightened — rotate gate, severity, label (#8028)
- Confirm dialog before worktree.restartService (#7909)

**Banner family**

- Seven banners converged on shared InlineStatusBanner chrome (#8026)
- Extended severity, fixed duration drift (#7974)
- Verb and icon drift fixed across Terminal banners (#7975)
- Banner-swap height transitions smoothed to stop xterm jitter (#7976)

**Panels & navigation**

- Review registered as the fourth built-in panel kind (#7792)
- Project switcher cross-view gate, numpad/shift+= support, directional MRU fix
- Departing project lastOpened bumped for Alt+Tab MRU toggle
- Dock density submenu surfaced in dock context menu (#7979)

**Notifications**

- Bell-blip throttle and divergent thread previews (#7967)

**Voice & Assistant**

- Microphone input device selector (#7902)

**Keybindings**

- Cmd/Ctrl shortcut collisions and AltGr swallowing resolved on Windows (#7941)

### Bug Fixes

**Terminal & PTY**

- Working non-agent terminals stay streaming when unfocused (#7997)
- Visible terminals wake on project view activation and worktree switch (#7999)
- Restarting banner shown during pty-host auto-restart backoff (#7905)
- Time-windowed crash-loop guard ported to pty-host (#7904)
- ResourceGovernor surfaces flowStatus, warning band, triage, and profile awareness (#7910)
- chcp banner suppressed with `>/dev/null` redirect
- UTF-8 forced in Windows fallback shells (#7949)
- chcp / fallback-shell mojibake on Windows resolved (#7949)

**Windows platform**

- Caption-button space reserved in toolbar and pre-React skeleton (#7951)
- ms-windows-store: protocol allowlisted in openExternal
- Build-type detection no longer treats every Windows build as Store (#7940)
- WSL default distro identified by `*` marker, not list order (#7944)
- Path normalizer treats UNC share as unescapable root (#7948)
- Worktree-id inference normalizes mixed path separators (#7950)
- Windows update metadata written to `<prefix>.yml` (no `-win` suffix)

**Crash recovery & resilience**

- Lazy overlay surfaces wrapped in ErrorBoundary, preventing fullscreen crash escalation (#7906)
- Backup triggers wired into appState mutations and window blur (#7903)
- focusPanelState clearing handled, partial-write resilience added (#7903)
- Silent auto-restore surfaced via inline confirmation banner (#7913)
- Watcher retry budget resets on refresh and wake (#7907)
- pty stability timer cancelled on crash to preserve the sliding window

**Errors & recovery**

- Infinite retry loop stopped; cross-session error recurrence tracked (#7908)
- Retry button flips to View errors after dock promotion; dedup keys normalized (#7914)
- Missing recovery action IDs registered for git error CTAs (#7915)
- IPC error classifier consolidated into a single-pass classifier (#7916)
- isTransient boolean replaced with a retryability discriminant (#7912)

**UI & EmptyState**

- Picker dialog and combobox empty states routed through EmptyState (#8022)
- Settings tabs keep section chrome visible during loading; empties routed through EmptyState (#8021)
- Diagnostics dock empty states routed through canonical EmptyState (#8015)
- ReviewHub completed states routed through user-cleared EmptyState (#8020)
- Fleet picker popovers use canonical EmptyState (#8018)
- Last full-area Spinners replaced with shape-faithful skeletons (#8014)
- Scroll-shadow gradient, fade transitions, and scrollbar thumb minimum polished (#8010)
- Tooltip primitive defaults polished, focus-visible filter added (#8008)
- Shared ScrollPill chrome extracted (#8011)
- Tooltip root remounts on visibility flip to clear stale Radix state
- DRAG_GHOST_OPACITY threaded through outlier drag-source dim sites (#8017)
- Whitespace-only sortable labels treated as missing with fallback coverage
- Empty issue-search input trimmed before API query
- Render-phase side effects moved into useEffect

**GitHub**

- prCiStatus drift between dropdown and sidebar resolved (#8006)
- Stranded tooltips in keepMounted dropdowns cleaned up (#8001)
- AnimatePresence replaced with plain conditional render in keepMounted dropdowns
- Bulk-bar pointer-events and post-completion dismiss cleanup

**Worktree & search**

- Search bar clearing hardened against debounce race and focus loss (#7970)
- Sidebar search clearing aligned with ARIA APG combobox pattern (#7970)
- Restart confirm dialog state resets when the error clears
- Blue chip and slate circle used for finished worktree card state (#7925)
- Combined-axis empty state copy clarified; active-count contrast lifted

**Project switcher**

- Waiting state described instead of asserting review needed (#8002)
- Dead 'open in background' affordance removed (#8027)
- MRU switcher simplified to immediate-switch model

**Sidebar accessibility**

- Alt+Arrow reorder blocked when grouped or searching
- List/grid keyboard contracts aligned with WAI-ARIA APG (#8012)
- Tablist arrow nav bails out for non-tab focus anchors

**Dock & layout**

- Populated trash pill armed state gated on panel drag
- Persisted dockDensity validated in v8 preferences migration
- Trashed-items type assertion replaced with a type predicate

**Agent panel & MCP**

- Title edit input feels inline (#7926)
- Double-confirm guard added; rotate disabled without suffix

**Voice**

- System-default microphone uses a sentinel value
- Type errors and lint warnings resolved across voice surfaces

### Performance

- Idle relative-time labels no longer wake every second (#8009)

### Other Changes

- Notify() tier tightened on six audited surfaces (#8024)
- Settings tab section titles converted to sentence case (#7968)
- Notify timers cancelled on remove and context switch
- Renderer path-string handling unified onto a shared utility (#7946)
- Shared prCIStatus utility extracted; CI indicators aligned
- projectMru moved to shared/utils
- CI: job-level e2e retry with `--last-failed` scoping (#7952)
- CI: shared retry gate centralized in one step
- CI: release dry-run workflow stabilised

## [0.10.2] - 2026-05-14

Patch release: stability and polish updates addressing WebGL terminal rendering, voice transcription, and UI sizing.

### Bug Fixes

- Resolved WebGL glyph corruption that occurred during atlas merge and agent terminal switching
- Fixed voice transcription flow to align with the `?intent=transcription` protocol
- Corrected dock terminal focus outline positioning to stay within item bounds

### Style & UI

- Bumped filter bar icon and label sizes in worktree view for better visual hierarchy
- Tightened overall icon and filter bar sizing across the UI

### Other Changes

- Lifted GitHub issue selection into a keyed Zustand store for improved performance
- Updated agent skill configuration (renamed fix-release-nightly to fix-workflow)

## [0.10.1] - 2026-05-14

Patch release: a whole-passage AI cleanup pass for voice dictation, plus fixes for terminal split layout, WebGL atlas rendering, and worktree filter bar tooltips.

### Features

- Voice dictation runs a whole-passage AI correction pass when recording stops, cleaning up the full dictated text in one shot; the corrected range shows a pending decoration while the pass runs

### Bug Fixes

- Two-pane terminal split now uses CSS grid fr tracks, fixing layout breakage when the container width is zero on first paint or stale during sidebar transitions
- WebGL texture atlas resyncs after page merges, clearing the stale GPU texture cache that could leave terminal glyphs corrupted
- Worktree filter bar tooltips migrated to Radix for consistent cross-browser styling
- Terminal drag ghost is centered on the preview width so it tracks the cursor correctly
- Whole-passage voice correction IPC is now validated

### Other Changes

- QuickStateFilterBar compacted to icon + count segments; arm-matching affordance moved into the filter bar's trailing slot
- Removed an orphaned split-button component, fixing the nightly knip job (#7899)

## [0.10.0] - 2026-05-14

Major release centered on the new Review Hub for staging, diffing, and pushing worktree changes, alongside the voice-backend migration to OpenAI Realtime and a broad pass of worktree, settings, and UI polish.

### Breaking Changes

- **Voice transcription backend switched from Deepgram to OpenAI Realtime API.** The voice subsystem now connects to `wss://api.openai.com/v1/realtime` and uses the `input_audio_transcription` event family (`delta` / `completed`) for streaming results. Spoken dictation commands ("new paragraph", "period", etc.) are reproduced in post-processing via `applyDictationCommands` since the Realtime API has no native equivalent.
- **API key settings unified into a single `openaiApiKey`.** The separate `deepgramApiKey` and `correctionApiKey` fields have been removed. Settings are auto-migrated the first time Voice settings are read after upgrade: existing `correctionApiKey` or `apiKey` values beginning with `sk-` move into `openaiApiKey`; `deepgramApiKey` is dropped. Users who only had a Deepgram key configured need to add an OpenAI API key in Settings → Voice for transcription to resume.

### Features

**Review Hub**

- Commit composer dialog gates commit & push so the message is reviewed before it ships (#7880)
- Multi-select for partial-set staging (#7790); keyboard hunk nav, per-file Viewed marks, persisted view type
- Inline divergence recovery for non-fast-forward push rejections
- ConflictPanel rebuilt into operation-chrome, worklist, and Continue regions (#7791)
- Section header filter / sort / view options; body-line ruler, multi-line overflow, commit history recall
- File-row chrome — split clicks, churn summary, generated-diff dimming, unresolved review-comment count
- PR chip split into read-only status pill + external-link button; PR CI status surfaced on worktree cards and Review Hub chip
- Streaming push progress; target branch shown in Review Hub
- Inline review strip and zero-change pill on agent panes
- Consolidated worktree-card commit surfaces into the Review Hub (#7886)

**Worktree**

- QuickStateFilterBar with state icons and spinning indicator
- WorktreeDeleteDialog body replaced with a static consequence list (#7847)
- Generated diffs collapse by default in DiffViewer
- Refractor chunk-load failures surfaced in diff viewer
- Sessions submenu adds Close All / Terminate All
- Freshness indicators on PR + Issue badges; focus-driven sub-line on collapsed rows

**Voice**

- Replaced Deepgram client with OpenAI Realtime WS
- Dictation-command post-processor for the OpenAI realtime path

**Daintree Assistant**

- Cmd+L default keybinding with three-state toggle and terminal-first focus (#7842)
- Gemini CLI and GitHub Copilot CLI wired into Daintree Assistant MCP

**Notifications**

- Completed-with-changes agents routed to review inbox

**Performance / Resource handling**

- Project switching: hover prefetch + visible swap decoupled from data hydration (#7660)
- Cached project views evicted under low system memory; frozen under efficiency profile
- `@parcel/watcher` adopted to eliminate macOS EMFILE in worktree watching
- PTY throughput-rate gauge added to reliability metrics

**UI / UX**

- ConfirmDialog hardened against destructive-confirmation drift (#7846)
- EmptyState contract — scale discriminant + container-query density (#7844)
- In-progress rebase shown as a commit sequence in the conflict UI
- Inline keyboard shortcut assignment for agents in Settings
- Split Commit / Commit & Push buttons on the commit composer footer
- Toolbar tri-state pinned with availability-aware visibility (#7673)
- RadioTower broadcast indicator on agent panel titles
- Fleet-picker footer adds visible Select all / Select agents buttons

**Security / Internals**

- secretScrubber: 15 new vendor patterns from the gitleaks catalog
- Renderer import discipline codified as a lint rule (#7659)

**Marketing**

- 3-OS marketing screenshots pipeline for Microsoft Store

### Bug Fixes

**PTY / Terminal**

- PtyPool crash-loop and FD leak on fast-exit shells; per-key circuit breaker + `destroy()` on pooled PTYs (#7892)
- Backgrounded terminal grid coherence preserved at wake-time resize (#7741)
- Suppressed wheel→arrow translation inside agent alt-screen TUIs
- Guarded against truncated session-ID captures in graceful shutdown
- Copilot `/exit` shutdown: single-write `quitSubmitMode`; 200ms `submitEnterDelayMs` to fix Ink TUI input drop

**Worktree / Git**

- Push-retry and diff race in commit composer
- `isPushing` deadlock; target branch re-emitted after auto-retry
- `git push` lock scoped per-cwd to prevent silent concurrent no-op
- Sidebar auto-reconciles after external worktree deletion
- Degraded-state visuals on GitHub badges (#7697)
- Filter chip counts aligned with visible list and arm payload
- Search-bar X visibility subscribed to facet-filter state

**Settings / UI**

- Section chrome renders instantly instead of full-area Spinner (#7851)
- Mutation affordances guarded during loading; load races fixed
- IssueSelector typeahead spatial anchor preserved (#7852)
- Getting Started checklist no longer auto-exits on completion (#7850); dismiss vs collapse distinguished (#7849)
- animate-pulse-immediate flash under 200ms on warm cache gated (#7853)
- ActionPalette empty / warm-start states polished (#7843)
- NotificationCenter inbox chrome and Undo toast polish (#7854); per-row reveal on mouse + keyboard (#7855)
- CopyableCommand contrast boosted; native title replaced with Tooltip (#7848)
- TwoPaneSplit: container width recovered on drag-end after locked unlock; ResizeObserver gated behind sidebar transition lock
- File viewer Cmd+L go-to-line preserved while modal open

**Agent / Fleet**

- Fleet directing-state broadcast (#7799); enter directing via `notifyUserInput` before submit
- `fleetBroadcastConfirmStore`: function removed from Zustand state; full clear on "Deselect all" so drifted IDs don't survive
- Agent `supports` field added to `UserAgentConfigSchema`; `isEffectivelyRegisteredAgent` hardened
- Agent launch description shortened to fit 120-char metadata limit
- `panelKindHasPty` restored for `hasPty` checks

**Boot / Project switching**

- Pre-agent snapshot pruning deferred to deferred task queue (#7656)
- `previousEntry` undefined → null coalesced; paint gate review-findings addressed
- Resource profile: low-memory threshold pushed on start so balanced is armed at launch

**Diff / Review Hub**

- Stale-request races, retry loading state, type guard
- Empty parse results from `parseDiff` guarded
- Selection anchor reseated when original is evicted
- Push-failure banner wired to recovery hints with collapsible details
- Rebase current-step detection corrected (git moves the failed pick to done)

**A11y / Forced-colors**

- `outline-none` replaced with `outline-hidden` for forced-colors compatibility

### Performance

- CodeMirror language-data curated to shrink vendor-editor bundle
- Radix overlay primitives deferred off first-paint closure
- Stale `React.memo` wrappers retired (superseded by React Compiler)
- PortBatcher flush cadence scoped per-terminal (#7652)
- Settings: redundant `useCallback` wrappers retired

### Other Changes

- CI: release unit-tests now run on macOS, Linux, and Windows (#7895)
- CI: Windows added to release E2E core, online, and full gates
- ESLint warning baseline trimmed; renderer-import lint rule landed (#7659)
- Documentation: README overhaul with new hero, vision doc extraction, daintree.org install links

---

## [0.9.1] - 2026-05-10

Same-day follow-up to 0.9.0. Polish on the Daintree Assistant pip and help panel, GitHub bulk-selection cleanup, and several PTY/terminal robustness fixes.

### Features

- **Assistant working/waiting state** — Toolbar pip and panel header now reflect live agent state (working / waiting), not just connected/idle (#7630)
- **Help-panel first-launch links** — Replaced seed-prompt chips with assistant-settings and docs links; added title-bar help icon (#7628)
- **Mark-as-read on assistant pip** — Pip dims after the assistant button is opened, no longer nags after the agent has been seen
- **Promoted assistant action surface** — Terminal and agent operations are now first-class actions in the help-prompt restructure

### Bug Fixes

**Daintree Assistant / Toolbar**

- Fixed assistant pip positioning (icon now wrapped in a relative container)
- Reduced assistant button pip size and ring weight to stop it dominating the toolbar

**GitHub bulk selection** (#7644, #7645)

- Clear selection on dropdown/dialog dismissal; preserve across re-open within the same project; clear on project switch
- Disabled pointer events on the bulk-action bar's exit animation so the X button no longer feels dead
- Guarded `isOpen`-effect cleanup against double-fire

**Layout / drag** (#7627)

- Suppressed width transition during sidebar/assistant drag; restored parent transition if the sidebar unmounts mid-drag

**PTY / Terminal**

- Released pause token if the commit-side throws, preventing a backpressure leak (#7641)
- Raised IPC queue cap from 512 KB to 3 MB for agent bursts (Claude in particular) (#7640)
- Unified broadcast and scroll pills so they no longer overlap (#7636)
- Flipped fleet drafting-pill popover alignment to `start` for bottom-left anchors

### Other Changes

- CI: Manual workflow dispatch now supports Windows
- Refactor: replaced `hybridInputAutoFocus` with a session-wide focus preference
- E2E: stabilized full-terminal suite against palette overlay races

---

## [0.9.0] - 2026-05-09

### Features

**Daintree Assistant**

- Bundled help session with Claude, Gemini, and Codex backends
- Live version probe gates assistant launch when the CLI is too old (#7539)
- Tier picker splits skip-permissions into supervised tiers + explicit CLI bypass (#7532)
- Hibernation captures Claude resume code so idle assistants release agent slots
- Custom CLI args, drop in-panel agent picker, and "+ New session" header button
- Right-side push sidebar layout for the assistant pane
- Tier-mismatch banner, auto-snapshot indicator, and live working-state in the help panel
- Per-session MCP tokens with hash-gated provisioning and stale-token rejection
- Single-backend invariant per project; cross-agent token reuse is a hard fail (#7509, #7533)
- Replace operational empty state with intent-first hero
- Settings tab dedicated to assistant configuration

**MCP Server**

- Streamable HTTP transport at `/mcp` with SSE-path readiness probe
- Per-tier authorization enforced at dispatch time and per-project tier opt-in
- Audit log for every tool dispatch with latency rollup, tier hints, and 401 counter
- Idempotency dedup for creation tools with bounded memory
- New tools: `agent.getState`, `terminal.getStatus` (batched fleet polling), `triage_terminals` prompt
- Project edit actions, consolidated worktree creation tool with PR support
- Native confirmation modal for `danger:"confirm"` tool calls and elicitation/create migration
- Prompts capability with starter slash commands; Daintree state exposed as MCP resources
- Workflow macro tools, terminal close/kill actions, and waitingReason on terminal state
- Allowlisted focus, theme, and read-only settings actions; default cwd/worktreeId/projectId from active context
- `outputSchema` and `structuredContent` on tool responses; ToolAnnotations on exposed tools
- Curated allowlist shrinks the default tool surface; assistant turn outcomes recorded alongside tool calls
- Persistent api key dropped from electron-store with rotate action
- Daintree MCP exposed to per-project Claude Code agents
- Fleet-polling recipe lifted into the `triage_terminals` prompt
- 4-state runtime readiness API and supervised restart

**Fleet Broadcasting**

- `FleetPickerPalette` is the cold-start fleet entry point with keyboard navigation (#6471)
- Save and recall named fleets
- Smart-arm bar suggestion pill and additive filtered arming
- In-flight progress counter for large broadcasts
- `FleetDraftingPill` shows resolved per-target prompts
- Health, worktree scope, and a leading exit surfaced on the fleet bar
- "+ Add panes…" in-popover picker on `FleetCountChip`
- Selection discoverability shortcuts, lifted row-ref management, fixed tooltip binding
- Multi-cursor terminal selection refinements and broadcast lifecycle polish

**Notifications**

- Keyboard navigation in the inbox; muted-state empty state when inbox is empty
- Pin severe entries, group by context, and mark new since last looked
- Suppress toasts when the origin surface is on screen; transient flag for confirmation toasts
- Per-event-kind silence from toast and notification-center kebab
- Undo on bulk mark-read; dismiss entire thread on X click
- Day-boundary timestamp pivot with absolute fallback
- BellOff indicator on muted projects in sidebar and switcher
- Leading-edge unread dot; legibility polish on inbox open
- `GridNotificationBar` entry/exit animation; thread visualization polish
- Toast eviction surfaced via overflow pill and bell animation

**Onboarding**

- Welcome screen first-run polish with quieter completion empty states
- Getting Started checklist completion choreography (counter accent, confirmation beat)
- Cold-start skeleton with Doherty gate and stuck-state cue
- Removed post-creation project onboarding wizard (#6750)
- Quieter first-run empty states across sidebar and content grid
- First-run shortcut pedagogy with 500ms hold and biased tip rotation
- Silent privacy default confirmed; capture wizard step on abandon
- `AgentTrayButton` shows a labelled empty state when no agents are pinned

**GitHub Integration**

- ETag-based REST branch-to-PR discovery
- Toolbar pill counts hydrated from disk cache on cold start
- +N delta badge since dropdown last opened; rising-count digit flash (#6529)
- Per-bucket rate-limit details tooltip
- Pre-warmed PR tooltip cache from poll batch
- Focus-aware `PullRequestService` cadence
- Background git fetch for worktree ahead/behind counts; freshness on dashboard cards
- Skeleton-to-content crossfade in dropdown lists; status indicator microcopy

**Recipes & Scratch**

- Scratch entity for one-off agent tasks with 30-day auto-cleanup and save-as-project promotion (#6778)
- Partial spawn failure surfacing with retry banner
- Async lifecycle hazard handling in recipe runner banner
- Project-recipe empty-state copy and CTAs polish

**Resilience & Recovery**

- Global host-crash banner with recovery action
- Linux Wayland multi-GPU ANGLE/Vulkan fallback
- `GpuCrashMonitor` sliding-window crash counter and structured logger
- External main-process watchdog for deadlock recovery
- Concurrent-OOM and rejected-window-recreation handling; suppress `app.quit` during OOM recreate
- Persistence: `foreign_keys` pragma, `quick_check` upgrade, disk-space pre-flight, TOCTOU close (#7568)
- Schema-version header on `.restore` files
- `pendingErrors` cap unified across renderer and main paths
- Sentry `maxBreadcrumbs` raised to 250 in main and renderer
- `ErrorBoundary` `onReset` hook for upstream state invalidation

**Security**

- Trusted Types adopted in the Daintree renderer (#6397)
- IPC trust envelope size and arg-count gate; correlationId in error envelopes
- Secret scrubber covers Vercel, Perplexity, xAI, Together, Resend, Heroku, Telegram, and Datadog token shapes
- `process.env` suppressed in Node diagnostic reports
- Trust-boundary invariants documented in `csp.ts` and `trustedRenderer.ts`
- Cross-agent token reuse is a hard fail in spawn

**Auto-Updater**

- Lifecycle state surfaced in the application menu and last-checked timestamp in settings
- Retry on Electron `net::ERR_*` transient errors with permanent-wins precedence
- Blockmap files included in release artifacts and R2 upload (#7570)
- R2 binary reachability verified before publishing metadata (#7569)
- macOS notarization staple verified after build (#7574)
- Monotonic publish gate blocks `latest.yml` regressions (#7573)

**UI & Interaction Polish**

- Chord-pill tooltips rolled out to top chrome, panel header, dock, and stash
- Palette headers migrated to `KbdChord` pill rendering with `aria-keyshortcuts`
- Command palette dialog animates height when results filter; opt-in shell defaults for action label, empty-state chip, and no-match copy
- Pickup lift animation and cancel snap-back on drag overlay; `KeyboardSensor` wired through `DndProvider`
- Panel tabs use Priority+ overflow menu in place of chevron scroll (#6429)
- `ConfirmDialog` typed-name primitive for destructive confirmations
- Terminal close-confirm dialog replaced with undo toast
- Unicode 11 width tables for emoji and CJK rendering
- Browser toolbar polish (zoom, load-state visuals)
- Dev preview viewport presets refreshed for 2025-2026 devices
- Settings dialog tablist, primitives, and persistence polish
- Action palette: foreground emphasis match highlight, footer hint reflects selected row, "Recently used" empty state, async loading affordance
- Worktree per-chip match counts and quick-state-filter zero-result recovery
- Toast success-flash on action buttons; row-recency cue in `FileChangeList` (#6544)
- Trash-dock active tab title in group label; dock drop targets neutral ring + drag-to-trash + ghost pill
- View Transitions API smooths cold-start handoff
- Skeleton primitive shared; `SkeletonHint` companion for long-tail loads

**Accessibility**

- Sidebar one-tab-stop worktree list (#6422); ARIA tightened on worktree grid keyboard model
- ARIA semantics on logs and event inspector
- IME composition guard and ARIA improvements in palette shell
- WCAG 1.4.11 contrast on active `QuickStateFilterBar` pill
- Screen-reader noise reduction in theme browser and palette components
- `kbd` chips exposed via `aria-keyshortcuts`
- `AccessibilityAnnouncer` timer cleanup and identity tracking
- Reduced-motion support and ARIA attributes on Getting Started checklist
- Dev-preview viewport-preset radiogroup a11y with persisted last preset
- Diagnostics dock keyboard, ARIA, and resize behavior

### Performance

- Cold-start: CLS flush gap closed, LoAF aggregation hardened, four warn-only first-launch quality signals
- Spawn-blocking critical path tightened for agent launches; env-keyed pty pool serves agent terminal launches
- Lazy-loaded 24 modal, palette, and dialog hosts; `@xterm/addon-webgl` pulled off the eager critical path
- React compiler bailout reasons captured in report; `BrowserPane.tsx` bailouts cleared
- Panel store: per-row selectors scoped via worktree index; redundant `useShallow` removed
- Workspace host: watcher-driven cadence, watcher pipeline tuning (#7455)
- Terminal: cursor blink centralized and silenced in background panes; scrollback churn gated; coalesced writes sliced to 32 KiB
- Git: `GIT_OPTIONAL_LOCKS`, `--no-renames`, `safe.directory` write dedup, byte-by-byte null-scan replacement (#7041)
- Per-file diff insertion/deletion counts cached
- Boot: non-critical service init deferred; connectivity probes and token-health start deferred; ResourceProfileService import deferred to first-interactive
- Font: JetBrains Mono cold-paint loading optimized; refractor language pack deferred out of cold start
- Project switch: outgoing state save parallelized with SQLite operations
- File tree: `lstat` parallelized, `realpath` memoized, empty fields omitted
- Console: auto-collapse cursor tracked by tail id; render-path allocations cut
- Per-frame visible-cell snapshot skipped for plain terminals
- Resource profile: hysteresis tuned, max-lag diagnostics added; service intervals paused on system suspend
- LazyMotion provider consolidated with dynamic features (#6391)
- Palette filtering deferred via `useDeferredValue` (#6415)
- Theme: RAF-coalesced injection DOM writes; portal offsets moved to `documentElement`
- Pty host: per-terminal byte queue aligned with renderer watermarks (#7453)
- ProjectStore `getAllProjects` reconciliation batched in a transaction
- `useResizeObserverRaf` hook with four ResizeObserver callsites migrated
- Window-blur throttle extended to `DiskSpaceMonitor`, `ProcessMemoryMonitor`, `IdleTerminalNotificationService`, `PreAgentSnapshotService`
- Idle-window timer-pressure perf scenarios added (PERF-090, PERF-091)
- List-mount perf budget added to E2E core suite

### Bug Fixes

- 870+ targeted fixes across spawn, pty, terminal lifecycle, multi-window, project-switch race conditions, theme, palette, drag-and-drop, sidebar, settings, dialogs, recovery, MCP server, help session, fleet, notifications, browser, dev-preview, diagnostics, e2e harness, build, CI, and Windows-specific identity paths
- Notable: agent terminal blanks during bulk worktree creation; armed fleet panes kept visible; force GPU slot release on terminal destroy; Cmd+W focus to next panel; Windows agent identity preserved during PowerShell prompts; Claude welcome identity preserved on Windows; ctrl shortcuts matched on Windows; project switcher MRU cycle includes current project for cancel; webContentsRegistry listener leak fixed
- Pty host: `droppedBytes` forwarded through event routing; IPC fallback queue drops surfaced as terminal-status; pause tokens released on dispose (#7453)
- Workspace host: hysteresis preserved through `ensureState` and recovered on focus

### Other Changes

- Plugin system: panel-kind registry events on register/unregister
- IPC error envelope shape unified across MCP server paths
- E2E core: 31 fixed 35s CCR poll waits replaced with state-backed polling
- Build: `win-job-object` externalized and made cross-platform; `node-addon-api` knip silenced

---

## [0.8.0] - 2026-04-30

### Breaking Changes

- Plugin manifests now use a strict `permissions` enum; manifests with unknown permission values fail to load
- Notes panel removed entirely; existing notes data is no longer surfaced

### Features

**Fleet — Multi-Agent Broadcasting**

- Fleet Deck dockable tile grid with live terminal mirrors
- Scoped fleet mode (default) with armed-terminal filtering and grid pinning of the composer
- Broadcast bar with frosted surface, exit semantics, paste safety, and discoverable selection menu
- Live per-character broadcast and a dedicated broadcast composer for armed terminals
- Canary staged broadcast for large fan-outs and auto-exit on idle
- Fleet quick-action hotkeys (accept, reject, interrupt, restart, kill, trash) and `Cmd+J` arm-focused
- Saved scopes, action history, dry-run, retry-failed, and quorum confirmation
- Cluster attention pill for proactive nudges, drafting pill, and per-pane failure tracking
- Multi-cursor terminal selection with shift+click range select; arming dialog filters by recent terminal output
- Sidebar “Arm N matching” button via `armMatchingFilter`
- Broadcast eligibility extended to runtime-detected agents

**New Built-in Agents**

- Aider (#6131)
- Goose (#6132)
- Crush
- Qwen Code (#6134)
- Open Interpreter
- Mistral Vibe
- Kimi Code CLI
- Sourcegraph Amp
- Generalised registry schema with per-agent files (#6130)

**Agent System**

- Runtime-detected agent identity becomes a first-class panel field — drives chrome, focus nav, refresh tier, dock fade, trash fallback, orchestrator routing, fleet eligibility
- `unauthenticated` availability state for installed-but-not-signed-in CLIs (lets the CLI handle first-run auth itself)
- Capability ID sealed at PTY spawn from launch intent (#5804)
- Layered probing and `blocked` state for security-software interference (#5134)
- Decoupled CLI launch from credential sniffing
- Automatic fallback chain when a preset provider is unavailable
- Committable shared presets via `.daintree/presets`
- Per-worktree preset scoping
- Toolbar agent button: redesigned preset selection and launch menus, active preset surfaced
- Right-click context menu improvements on the agent button

**Plugin System**

- Manifest with permissions, runtime action registration, and host API/context injection
- `contributes.views` and `contributes.mcpServers` reserved
- Per-plugin unregister for contribution registries
- `engines.daintree` semver gating
- Scoped `publisher.name` plugin IDs required
- Read-only worktree state exposed to plugins
- Placeholder panel rendered when a plugin contributing a panel kind is unavailable

**GitHub**

- Instant dropdown opens via combined prefetch, eager chunk loading, and disk-persisted first-page cache
- `keepMounted` via React Activity for zero-latency re-opens
- Hover-prefetch on toolbar button
- Token-expiry detection with reconnect banner; high-priority notification on expiry
- Rate-limit-aware backoff using response headers; transient network retry
- Stale-data timestamp shown in inline error banner

**Performance**

- Optimistic panel commit decouples agent launch from PTY spawn
- Real cold-start scenario harness with A/B comparison (#5410)
- Renderer bundle size CI budget gate
- RAM-tiered cached project view defaults with LRU eviction; eviction telemetry on revival/cold-start
- FLIP panel motion on column-count changes; breakpoint hysteresis on auto grid columns
- WebGL context release when terminal goes off-screen
- Visibility-gated pollers and shared minute ticker for headers
- Migration-path latency regression gate (PERF-080)
- xterm `rescaleOverlappingGlyphs` and `reflowCursorLine` enabled
- Thermal and CPU speed-limit signals fed into ResourceProfileService
- GPU tile memory cap scaled by system RAM tier
- Knip dead-code analysis and expiring-TODO lint added to CI

**Settings**

- Radix-based primitives: Checkbox, Switch, native-select replacement
- Bordered env-var editor with `.env` paste flow and literal-secret warning
- Preset/default scope unified into a single editor; presets inherit from agent defaults with reset UI
- Hover preview in app theme picker
- Validation error indicators on settings tabs
- Tightened section boundaries on CLI Agents page
- Settings shortcut capture extracted as primitive
- Choicebox primitive extracted from DockDensityPicker

**Theme System**

- Theme browser panel with sticky hero and commit bar
- Semantic info-tone migration off accent token to `status-info`
- Bondi and Daintree theme tokens refined
- CSS color and hero-image validation on custom theme import
- Form-state semantic tokens for settings primitives

**Notifications**

- Quiet hours schedule
- Mute-from-toast for project notifications (#5401)
- Persistent banners replace transient toasts for cloud-sync and GitHub-token failures
- Same-entity toasts collapse instead of FIFO eviction
- DND state shown on toolbar bell; consolidated DND controls into a Pause popover
- “Clear all” moved into overflow menu

**Browser & Dev Preview**

- Favicons in URL bar and per-row history deletion
- Hard-reload action that bypasses HTTP cache
- Per-project approval for LAN, Docker, and TLD hosts
- Mobile and tablet viewport presets for dev preview
- Assigned URL and port registry in `DevPreviewSessionService`

**Onboarding**

- First-run welcome card and agent discovery badge (#5111)
- Setup wizard demoted to inline banner; visible section structure on its first step
- “Set Up Agents” footer item in agent tray
- Random emoji button and Enter-to-save on project onboarding

**Recovery & Resilience**

- Safe-mode banner with restart action and crash detail
- Crash-page copy varied by reason
- Diagnostics export and open-logs actions on the recovery screen
- Diagnostic bundle wrapped as zip with pre-save review step
- Quarantined project state surfaced via recovery notification
- Persistent transient errors escalated to user-visible toasts

**Terminal & PTY**

- Explicit PTY lifecycle state machine replacing implicit flags
- Scrollback repair and degraded-mode banner on runtime agent promotion
- Capability ID sealing at spawn from launch intent
- Command-launch pgid hardening and chrome-affinity tightening
- Linux copy-on-select and middle-click paste
- Match counter and highlight-all in the terminal find widget
- Preset args persisted and rehydrated through restart/resume
- Heartbeat RTT measurement with p50/p95/p99 logging

**Action Palette**

- Frecency-based MRU sorting replaces LRU
- Context-relevant action boost and keyword scoring
- Instant filter with origin-scaled entry animation
- `action.repeatLast` bound to `Cmd+Shift+.`
- Disabled-action reasons shown inline; toast on disabled-action dispatch

**Worktrees**

- WSL-mounted worktree detection — git routed through `wsl.exe`
- Linux inotify watch-limit degradation surfaced as a toast (#5229)
- Stale snapshot detection via heartbeat gap
- macOS EMFILE handling in the recursive worktree watcher
- Inline cleanup affordance on merged worktree cards
- Conditional tooltips for truncated paths and branch names
- Reviewhub surfaces merge/rebase/cherry-pick/revert conflicts
- Dubious-ownership git error gets an actionable toast

**Project**

- Fast MRU project switcher on `Cmd+Alt+−/=` (#5143)
- Auto-discover and offer to import context files
- Scope indicators on settings widgets

**Logs**

- Structured per-module log levels with named loggers
- Log rotation and previous-session log preservation
- Renderer console warnings and errors captured into the main log
- Log viewer polish — severity, tokens, tail, copy, dedup

**IPC**

- Typed handler migration across six batches; type-branded handler returns to forbid `{ok|success}` keys
- Typed event pub/sub foundation; channel-drift CI test
- `safeFireAndForget` wrapper for fire-and-forget IPC
- `AppError` class; rate limits on `github`, `files:search`, and `project:get-bulk-stats` handlers

**Security**

- CSP added to the `persist:daintree` session
- Secret scrubber catalog extended with 2026 vendor sigils
- Free-text secret scrubbing in telemetry and diagnostic bundles
- Outbound log and IPC error sinks scrubbed; IPC error envelope `userMessage` scrubbed
- Realpath containment in `daintree-file` protocol; symlinks resolved before containment check
- Sandboxed env vars and secret scrubbing in agent CLI probes

**Telemetry**

- Activation funnel instrumentation; newsletter checklist item replaced
- Sentry action breadcrumbs for crash triage
- Project state save/read latency and size telemetry
- Project-view eviction, revival, and cold-start events
- Outbound payload preview during a session
- `@sentry/electron` native minidump uploads disabled

**Animations**

- Structural micro-animations for spatial continuity across reflows
- Shared motion timing tiers and named constants in `animationUtils.ts`
- Component-level reduced-motion handling and continuous-loop dial-back (#5696)

**Accessibility**

- ARIA page landmarks for `F6` pane cycling (#5416)
- ARIA role corrections across panel layout

**Other Features**

- Empty states across recipes, MCP, GitHub, and agents — first-run, filtered, and cleared variants
- Reusable `EmptyState` component
- Held-modifier shortcut reveal in the toolbar
- Hover-based shortcut hints for unused actions
- Fuzzy search and chord prefix detection in shortcut reference dialog
- Inline unbind buttons for keybinding conflicts
- Per-agent launch keybinding model rethought
- Theme browser claims an overlay (hides Portal and blocks its toggle)
- Visual indicator for dangerous agent launch flags
- Demo runner replaces `capturePage` poll with `getDisplayMedia` + `MediaRecorder`
- CCR flavor system: shared types, IPC, store, registry merge helpers, picker UI, env-var hardening
- Persisted-store registry for diagnostics introspection
- Centralized boot migration pipeline; column probing replaced with drizzle migrations
- Boot-time WAL journal cap and `SQLITE_FULL` recovery wrapper
- Per-service connectivity awareness
- Resilient atomic write consolidation across all state writes
- Sound design — vary working pulse pitch to slow habituation
- Custom `BrandMark` icon wrapper for adaptive agent icon theming

### Bug Fixes

735 bug fixes across the categories above. Highlights:

- View-crash recovery: clear queued bytes, scope crash to active project, tear down ports, re-broker producer ports for cached-view reactivation
- Notify reentrancy guard, mute-confirmation priority, and fallback recovery actions
- Force-crash renderer instead of reload on unresponsive; clearer force-restart copy
- Files: `daintree-file` realpath containment; `..`-prefixed filenames allowed; close-error masking and POSIX-root edge cases addressed
- Crash-guard: state writes use `resilientAtomicWriteFileSync`
- Persistence: `withDiskRecovery` error matching tightened with coverage
- Disk-pressure: non-critical writers honour `writesSuppressed`
- Agent: waiting watchdog recovers from silently-dead subprocesses
- Workspace-host: scrubs secrets from recipe stdout before agent context injection
- Portal: `will-frame-navigate` gates subframe navigations; in-page navigations to non-`http(s)` schemes blocked
- Browser: localhost CSP overlay skipped for browser partition
- GitHub: clear stale rows when cache holds an empty page on Activity reveal; hover-prefetch race conditions closed; raw rollup fallback when no required checks
- Theme: hard-coded chromatic utilities replaced with semantic status tokens
- UI: residual accent uses demoted across dock, drag ghost ring, group badge, and AutomationTab create-recipe link
- Errors: silent `.catch` swallows replaced with logging and selective notifications
- Build: `tsc` typecheck output redirected away from esbuild bundle dir
- Memory: Blink memory unit corrected (KB not bytes); IPC validation hardened

### Other Changes

- Agent registry reordered by popularity; documentation updated to cover all 15 supported CLIs
- README and docs refreshed; `evaluate-feature` command removed
- Nightly CI gains an integration-test stage; PR/push CI tightened to Ubuntu-only smoke
- ESLint warning ratchet introduced for renderer hygiene rules
- Fix-with-test ratio tracking script added

---

## [0.7.1] - 2026-04-17

### Features

- Gate `--turbopack` injection on Next.js 15+ with a per-project settings toggle (#5154)
- Terminal Info dialog now shows spawn command, arguments, and agent metadata (#5169)
- Raise bulk worktree creation concurrency from 2 to 3 (#5163)
- Privacy & Data settings disclose the specific telemetry fields collected at each level (#5258)

### Bug Fixes

- Capture renderer-side errors via `@sentry/electron/renderer` so crashes reach Sentry (#5256)
- Consolidate telemetry consent into a single `privacy.*` store field, fixing stale-consent drift (#5257)
- Flush Sentry events before `app.exit` so queued crash reports are not lost (#5254)
- Stop dropping 90% of Sentry crash reports — sampleRate now fails closed (#5255)
- Generate the agent command when cloning a panel layout (#5179)
- Raise per-renderer tile memory cap and clean up GPU flag switches (#5180)
- Worktree cycle actions walk the sidebar-rendered order (#5170)
- Refresh sidebar immediately after saving a GitHub token (#5166)
- Suppress agent-tray tooltip from reappearing after its dropdown closes (#5153)
- Default-pin agents based on CLI install state instead of an opt-out list (#5158)
- Agent tray hides uninstalled agents and refreshes mid-session (#5157)
- Rebrand migration runs when an empty `daintree.db` is already present (#5156)

### Performance

- Eliminate bottlenecks in the worktree creation critical path (#5161)
- Batch pre-queries in the bulk worktree creation dialog (#5162)

### Other Changes

- Treat panel `worktreeId` as renderer-owned layout state (#5139)
- Update repo references from `canopyide/canopy` to `daintreehq/daintree`; add Canopy rename notice to README
- Release workflow gates publish jobs on unit tests and wires `SENTRY_DSN`

---

## [0.7.0] - 2026-04-16

### Features

**Daintree Rebrand**

- Rename Canopy to Daintree across types, icons, menu, and UI copy (#5149)
- Migrate userData and `.canopy` directory rename to `.daintree` (#5149)
- Flip protocol scheme app://canopy → app://daintree, canopy-file → daintree-file
- Rename `CANOPY_*` env vars to `DAINTREE_*` with back-compat shims
- Dual-variant release builds (Canopy + Daintree) via BUILD_VARIANT (#5151, #5130)

**Setup Wizard**

- Three-state CLI availability model: missing, installed, ready (#5057, #5043)
- Tiered agent list in setup wizard selection step (#5054, #5047)
- Replace embedded terminal with install cards (#5056, #5044)
- Animated step transitions with reduced-motion support (#5055, #5045)
- Auto-skip install step when all selected agents are installed (#5053, #5050)
- Fold system health check into agent selection step (#5060, #5046)
- Consolidate welcome step into agent setup wizard (#5061, #5048)
- Unify wizard and settings into shared agent card components (#5062, #5049)
- Skip-permissions toggle in agent CLI step (#5042, #5026)

**Theme System**

- Command palette and toggle for theme switching (#5081, #5069)
- Live preview on hover in theme pickers (#5088, #5068)
- Track recently used themes in picker (#5082, #5071)
- Accent color override for themes (#5095, #5074)
- Circular reveal animation for theme switches (#5087, #5073)
- Inline theme list with thumbnail previews replaces modal picker
- Updated theme hero images and tuned accent/terminal palettes

**Agents**

- Add GitHub Copilot CLI as built-in agent (#5067, #4555)
- Add Kiro CLI to README and improve auth detection (#5096, #5101, #5093)
- Agent tray button for unpinned and uninstalled agents (#5089, #5075)
- Default agents to pinned (opt-in toolbar) and rename selected to pinned (#5123, #5109)
- Active-session detection and focus shortcut on agent buttons
- Derive agent buttons dynamically from registry (#5078, #5070)
- Bulk operations can target specific agent terminals (#5086, #4772)

**Notes**

- Voice input in notes panel (#5063, #5059, #4425)

**Worktrees**

- Per-worktree remote compute lifecycle — lease, connect, manage cloud resources (#5007, #4426)
- Differentiate worktree card hover and selected states (#5077, #5065)

**Notifications**

- Notify user about idle terminals in background projects (#5083, #5064, #4745)

**Project Switching**

- Previous/next project shortcuts for fast MRU switching (#5142)

**Other Features**

- CONTRIBUTING.md for community contributors

### Bug Fixes

**Hydration & Persistence**

- Prefer saved worktreeId over stale backend value on rehydration (#5144)
- Preserve custom session names across project switches (#5105, #5103)
- Persist lastSelectedNoteId on save and harden notes save lifecycle (#5125, #5119)
- Apply same worktreeId precedence fix to reconnect path

**Workspace & Resources**

- Shell-escape substituted variables to prevent command injection (#5145, #5129)
- Serialize concurrent resource actions per worktree (#5147, #5127)
- Surface resource action failures to the user (#5146, #5128)
- Emit abort events and cleanup resource queues on dispose
- Exclude root worktree from PR branch-name matching (#5122, #5104)

**Multi-Window**

- Show project picker for user-triggered new windows (#5120, #5033, #5034)
- Resolve sender window for open dialog in multi-window (#5148)

**Terminal & PTY**

- Recover from xterm DOM renderer IntersectionObserver pause (#5092, #5085)
- Warm PTY pool at project cwd, skip on cwd mismatch (#5102, #5097, #5091)
- Replace sliding-window rate limit with leaky bucket for worktree creation (#5106, #5098)
- Cancel leaky bucket waiters on drain to match shutdown semantics

**UI**

- Stop FixedDropdown from self-closing on cold-start overlay race (#5090, #5084)
- Toggle thumb contrast on dark themes (#5099, #5094)
- Refresh LegacyMigrationBar design and copy
- Center migration bar layout and update rename messaging
- Hide worktree sidebar on welcome screen before project opens
- Increase notification panel opacity for legibility (#5051, #5040)
- Reload page when pressing Enter on unchanged URL (#5052, #5036)
- Hide uninstalled agents in System Status (#5079, #5072)
- Remove dedicated panel-palette toolbar button (#5121, #5116)
- Improve GitHub toolbar button UX when token not configured

**Cross-Platform**

- Cross-platform path handling in file stores and tree service
- Resolve Windows CI failures from path separator and shell quoting (#5152, #4708)

**Build & Release**

- Consolidate release output dir and harden nightly/update pipeline
- Preserve prerelease feeds and canopy-file links across rebrand
- GitHub Actions workflow to notify website on repo events

### Performance

- Adaptive backoff in ProcessTreeCache polling (#5124, #4818)

### Testing

- Adversarial test sweep — 22 rounds, 56 source bugs fixed across IPC, services, and stores (#5140)
- Repair nightly E2E onboarding and online agent flows (#5138)
- Propagate SKIP_FIRST_RUN_DIALOGS to sandboxed renderer (#5080, #5066)

---

## [0.6.0] - 2026-04-08

### Features

**Help System**

- Persistent HelpPanel with SearchSocket MCP for documentation search (#4939)
- Help agent dock button with agent picker and session continuity (#4938, #4937)
- Fast models used by default for help assistant (#4969)

**Project Switcher**

- Frecency-based project sorting with temporal sections (#4908, #4926)
- MRU ordering with second item pre-selected for quick toggle (#4989)
- Push-based project status replacing N+1 IPC polling (#4902)

**Panel Architecture**

- Unified PanelKindRegistry merging config, components, serializers, and defaults (#5002, #5003, #5004)
- Co-located panel kind modules into `src/panels/` directory (#5006)
- Renamed terminal store and types to panel (#5005)

**Per-View Worktree Stores**

- MessagePort broker with request/response protocol for per-view worktree data (#4834)
- Per-view worktree store replacing global store (#4862)
- Cached view rehydration and issue association hydration (#4862)

**Recipes**

- In-repo recipe storage with `.canopy/recipes/` as default for project-level recipes (#4936)
- Save-to-repo action for promoting user recipes to project storage (#4940)
- Support editing and deleting in-repo recipes (#4933)
- Custom CLI arguments per terminal in recipe editor (#4963)

**Demo System**

- Scene/Stage DSL with runner and capture pipeline for demo video production
- Scroll, drag, pressKey, spotlight, annotate, and waitForIdle primitives
- Raw BGRA bitmap piping with text-crisp encoding

**Other Features**

- Agent 'exited' state for cleanly terminated terminals (#4998, #4999)
- OAuth loopback flow for external auth redirects in dev preview (#4980)
- Git credential support for private repo operations (#4948)
- Per-agent assistant model selection in settings (#4962)
- Smart defaults for new worktree panel layout (#4993)
- Theme picker replaced with dedicated AppDialog modal (#4991)
- Existing branch mode in New Worktree dialog
- Terminal "Move to New Worktree" action for agent panels
- Cmd+T falls back to last-closed terminal config (#4717)
- Panel palette shows agent availability status (#4918)
- Clone Repository improved discoverability (#4884)
- Toolbar shows only installed agents with auto-open setup wizard (#4994)
- Include main worktree in bulk operations
- ScrollShadow component for scrollable containers
- Structural skeleton fallbacks replacing loading spinners
- Custom Canopy icon set additions
- Fullscreen state persisted and restored across sessions
- Blocked cross-origin navigations surfaced with Open in Browser action
- Standardized settings dialog layout and form components (#4883)
- Soundscape toned down to minimal defaults

### Bug Fixes

- Fix terminal blank panels on Linux/Windows from fit/resize race (#4913, #4935)
- Fix phantom agent terminals appearing on project open (#4911, #4881)
- Fix agent terminal getting stuck in working state (#4974)
- Fix dock state corruption on docked terminal expand and project switch (#4945)
- Fix project settings not persisting after dialog consolidation (#4958)
- Fix clone dialog hanging with cancellation support (#4949)
- Fix help terminal leaking into dock on project switch (#4978)
- Fix hybrid input bar drafts lost on project switch (#4977)
- Fix agent terminal panels not restored on cold app restart (#4973)
- Fix Windows voice correction path handling (#4979)
- Fix dev preview losing navigated URL on worktree/project switch (#5017)
- Fix palette not selecting first navigable item on open
- Fix tab group panels leaking between dock and grid
- Fix project switch losing active worktree selection (#5011)
- Fix project switch state capture and flush (#5009)
- Fix oversized window recovery regardless of visibility
- Fix menu DevTools and zoom items targeting wrong webContents
- Fix worktree delete dialog conflating untracked and uncommitted changes (#4927)
- Fix recipe editor dialog overflow scrolling (#4957)
- Fix terminal data loss and render freeze on project switch
- Fix stale draft restoring after submit and project switch (#4990)
- Fix dev preview auto-injecting --turbopack for Next.js (#4557)
- Fix Windows registry PATH expansion for tool discovery (#4932)

### Performance

- Startup performance capture pipeline with end-to-end timing (#4859)
- Lazy-load HybridInputBar for non-agent terminals (#4831)
- Lazy-load NewWorktreeDialog (#4835)
- Adaptive batching on MessagePort data path (#4899)
- Compile caching for UtilityProcess entry points (#4837)
- Throttle polling services when window is backgrounded (#4838)
- Bound coalesced terminal batch size to 256 KB (#4853)
- Normalize terminal store from array to Record for O(1) lookups (#4902)
- React Compiler switched to infer mode (#4836)
- Reduce scrollback multipliers to lower memory baseline
- Batch IPC broadcasts with 50ms flush window (#4834)
- Debounce MRU list persistence in store orchestrator (#4830)
- Singleflight cache for workspace state queries (#4832)
- Fire-and-forget recipe loading on initial hydration (#4852)
- Defer MessagePort ACK to xterm write callback (#4862)
- Pre-compute command queue count per terminal (#4833)
- Use replaceChildren() to clear hibernated terminal DOM (#4828)

---

## [0.5.3] - 2026-03-28

### Features

- Move notes storage from project directory to user data (#4399)
- Use first line of note content as display title instead of date-based default (#4397)
- Unify scroll indicator pill design across terminal and worktree sidebar (#4409)
- Disable text selection on app chrome for native feel (#4313)
- Add PtyPauseCoordinator for coordinated PTY flow control (#4384)
- Add Chromium GPU memory flags to reduce VRAM usage (#4365)
- Update logo to R5 design and rebrand to #36CE94
- Add Liquid Glass .icon bundle for macOS 26+

### Bug Fixes

- Fix EPIPE crash caused by console.log in CSP handler
- Fix notes losing content and disappearing after closing palette (#4396)
- Prevent loading flash during notes background revalidation (#4398)
- Fix notes debounced save flushing before auto-delete (#4396)
- Fix IME composition guard dropping Enter key after voice input (#4356)
- Fix grid arrow-key navigation using wrong column when moving up/down (#4297)
- Fix ReviewHub fatal git error when comparing same branch (#4352)
- Fix quit warning counting trashed agent panels as still running (#4350)
- Fix task assignment triggers dropped when orchestrator lock is held (#4366)
- Close SQLite connection explicitly during shutdown (#4354)
- Abort voice correction fetch on timeout via AbortSignal (#4359)
- Constrain dropdown and context menu height to available viewport space (#4239)
- Configure ImageAddon with memory-safe defaults (#4363)
- Revert privacy settings UI on IPC failure and show error toast (#4386)
- Add accessible names to GitHub settings token input and buttons (#4388)
- Add dialog accessibility to CrossWorktreeDiff modal (#4385)
- Suppress update error notifications for automatic checks (#4370)
- Add cursor-pointer to Button component and crash modal buttons (#4266)
- Clarify crash modal button and privacy warning text (#4264)
- Prevent dark-mode color-scheme inheritance into browser webview (#4351)
- Polish empty state spacing, recipe summary, and tip contrast (#4406)
- Fix agent state machine: add completed to waiting valid transitions (#4358)
- Suppress unhandled rejection in macOS editor open fallback (#4362)
- Add \_retried guard to getProjectHealth recursive call (#4353)
- Tone down hybrid input bar styling and fix bottom radius leak

### Performance

- Reduce V8 heap limits and remove --optimize-for-size (#4364)

---

## [0.5.2] - 2026-03-27

### Features

- Recover from renderer process crashes instead of showing blank window (#4274)
- Surface settings recovery status to user via toast notifications (#4272)
- Hardware-aware panel limits with permanent disable option (#4284)
- Proactive disk space monitoring with user warnings (#4278)
- Crash loop protection with safe mode boot (#4273)
- Prevent system sleep during active agent work with powerSaveBlocker (#4279)
- Warn users when project path is in a cloud-synced folder (#4282)
- SQLite database backup, WAL checkpoint, and corruption recovery (#4276)
- Add watchdog to WorkspaceClient matching PtyClient pattern (#4277)
- Auto-cleanup quarantined .corrupted files older than 30 days (#4281)
- Add hard timeout to graceful shutdown to prevent app hanging on exit (#4275)
- Enrich crash reports with environment metadata (#4270)
- Add backup and restore to settings store initialization (#4271)
- Update Canopy icon to V2 design

### Bug Fixes

- Scope focus fallback to active worktree on panel close (#4327)
- Add atomic write utilities and migrate all important file writes (#4280)
- Prevent worktree showing finished while agents are still active (#4268)
- Make empty toolbar space draggable for window management

---

## [0.5.1] - 2026-03-26

### Features

- Skip model selection in panel palette and launch agents directly (#4256)
- Auto-select next agent terminal when closing with Cmd+W (#4236)
- Auto-poll prerequisite status every 3 seconds during setup (#4244)
- Embed terminal in system health check step for interactive installation (#4243)
- Add OS-specific install instructions for system prerequisites (#4242)

### Bug Fixes

- Fix welcome screen buttons flashing when project switcher opens (#4255)
- Correct Notes font family from monospace to sans-serif (#4252)
- Fix agent terminal flash when focused or reparented (#4226)
- Move logger init after single-instance lock to prevent log clearing (#4237)
- Refresh PATH before recheck to detect newly installed tools (#4241)
- Persist agent setup IDs across restarts (#4245)
- Fix toolbar overflow menu alignment and collapse behavior

### Other Changes

- Split E2E tests into core (release gate) and full (nightly) tiers
- Add local unsigned packaging scripts
- Fix native module packaging and afterPack arch mapping for builds

---

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
