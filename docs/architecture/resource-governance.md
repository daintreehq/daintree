# Adaptive resource governance (profiles, pressure, eviction, hibernation)

## Purpose

Running 5–10 agents — each with its own dev server, terminal, and Chromium renderer — puts real pressure on a developer's machine. Daintree adapts to that pressure instead of running flat-out: a single main-process service (`ResourceProfileService`) watches a handful of system signals, collapses them into one of three coarse **profiles** (`performance` / `balanced` / `efficiency`), and fans that profile out to ~7 subsystems that each tighten or loosen their own knobs. A separate, cross-process governor (`ResourceGovernor`, in the PTY host) handles the hard, fast case — imminent OOM — by pausing terminal output directly.

This doc is the map for that machinery: the signals, the profile state machine and its hysteresis, the fan-out contract per consumer, and how the profile reaches the renderer.

## Mental model

Two loops, different time constants:

- **Slow loop — `ResourceProfileService`** (`electron/services/ResourceProfileService.ts`, ~818 LOC). Runs in the main process on a 30 s aligned interval. Aggregates memory, thermal, battery, CPU-speed-limit, fleet-size, system-available-memory, and terminal-workload-memory signals into a `pressureScore`, maps the score to a profile, applies asymmetric hysteresis, and pushes the resulting `ResourceProfileConfig` to every consumer. This is **policy** — it changes cadences and budgets, never pauses anyone.
- **Fast loop — `ResourceGovernor`** (`electron/pty-host/ResourceGovernor.ts`, ~525 LOC). Runs in the **PTY host process** on a 2 s interval, watching V8 heap + external memory across **every isolate in the process** — its own, plus the analysis workers' self-reported samples (see [Cross-isolate accounting](#cross-isolate-accounting-analysis-workers)). When memory approaches its budget it pauses terminal output (the `paused-resource-governor` flow state) and resumes when pressure clears. The profile service feeds it one input — `setResourceProfile(profile)` — which lowers the governor's thresholds under `efficiency`; otherwise the governor is autonomous.

Bridging the two: a third fast path lives **inside** `ResourceProfileService` — an event-loop-lag monitor (5 s interval) that can force the whole app into `efficiency` immediately, bypassing the slow loop's hysteresis, when the JS thread is genuinely saturated.

```
                       ┌─────────────────────────────────────────────┐
   signals ──30s──▶    │  ResourceProfileService (main process)       │
   (mem/thermal/       │  ─ computeTargetProfile() → pressureScore    │
    battery/CPU/       │  ─ hysteresis (downgrade 30s / upgrade 90s)  │
    fleet/sys-mem)     │  ─ lag monitor (5s) → fast-path → efficiency │
                       └───────────────┬─────────────────────────────┘
                                       │ applyProfile(p): fan out RESOURCE_PROFILE_CONFIGS[p]
        ┌──────────────┬───────────────┼───────────────┬───────────────┬──────────────┐
        ▼              ▼               ▼               ▼               ▼              ▼
  WorkspaceClient  HibernationSvc  PtyClient ──▶   ProjectStats   ProjectViewMgr   renderer
  (poll/fetch/     (mem-pressure   PTY host:       (poll cadence)  (freeze + LRU    (webgl mode,
   watcher cap)    idle threshold) ResourceGovernor                cap + paint gate) fetch intervals)
```

The profile is intentionally **coarse**. There are only three states, so every consumer's per-profile values live in one table (`RESOURCE_PROFILE_CONFIGS`) and the policy is auditable at a glance. Consumers never read raw signals; they read the profile config they're handed.

## Signal inputs

`computeTargetProfile()` (`ResourceProfileService.ts:601`) sums a `pressureScore` from these signals. App, terminal-workload, and fleet thresholds scale with physical RAM. System-available memory uses RAM-relative thresholds capped at 1 GB critical / 2 GB warning so a high-memory macOS machine's normal file-cache occupancy cannot manufacture a multi-gigabyte "critical" floor.

| Signal | Source | Contribution to `pressureScore` |
| --- | --- | --- |
| App-private memory | `app.getAppMetrics()`, summed `memory.workingSetSize` | `+2` above `HIGH_FRACTION` (0.15 × RAM), `+1` above `LOW_FRACTION` (0.08 × RAM) |
| Battery | `powerMonitor.isOnBatteryPower()` + `on-battery`/`on-ac` events | `+1` while on battery |
| Thermal (macOS only) | `powerMonitor` `thermal-state-change` + `getCurrentThermalState()` | `+2` critical, `+1` serious |
| CPU speed limit (macOS & Windows) | `powerMonitor` `speed-limit-change` | `+2` below 50, `+1` below 100 |
| Active-agent fleet size | cached count from `PtyClient.getAllTerminalsAsync()`, filtered | `+3` ≥ 24, `+2` ≥ 16, `+1` ≥ 8 |
| System-available memory | `process.getSystemMemoryInfo()` (free + purgeable on macOS, free elsewhere) | `+3` below `min(0.1 × RAM, 1024 MB)`, `+1` below `min(0.2 × RAM, 2048 MB)` |
| Terminal-workload memory | cached `PtyClient.getMemoryRollup()` (descendant RSS from the pty-host `ProcessTreeCache`, PID-deduplicated, via `electron/services/memoryAccounting.ts`) | `+2` above 0.4 × RAM, `+1` above 0.25 × RAM — only from a fresh (≤ 60 s), successful process-table sweep; stale/unavailable data contributes 0. Per-tier 10% exit band. Bounded at +2 so terminal workloads alone can never latch `efficiency`. |

Mapping (`ResourceProfileService.ts:669`): `score >= 3 → efficiency`, `score === 0 → performance`, otherwise `balanced`.

**Why fleet size counts agents, not worktrees** (`countActiveAgentTerminals`, `ResourceProfileService.ts:488`): an idle worktree costs negligible incremental memory, but each running agent runtime (Claude/Gemini/Codex) is ~200–500 MB resident. A terminal counts only if it is not trashed, still has a PTY (`hasPty !== false` — orphaned terminals carry stale agent metadata), is in `ACTIVE_AGENT_STATES` (`working` | `waiting` | `directing`, from `shared/types/agent.ts`), and has an agent identity (`detectedAgentId`, or a `launchAgentId` that hasn't yet been superseded by `everDetectedAgent`). The graduated +1/+2/+3 curve exists because a flat +1 made an 8-agent and a 24-agent fleet score identically.

The fleet count is **cached** and refreshed asynchronously each tick (`refreshFleetState`, `:459`). A monotonic `refreshGeneration` counter drops out-of-order or stale-lifecycle responses. Under sustained lag the refresh is skipped entirely (the only optional async work in the service) and the last cached count is reused.

### Event-loop-lag monitor

Separate from the score, the service owns a tumbling-window event-loop-delay histogram (`monitorEventLoopDelay`, 10 ms resolution) sampled every `LAG_SAMPLE_INTERVAL_MS` (5 s) and reset after each window so `percentile(99)` reflects only the recent slice (`sampleLag`, `:311`). Lag entry is **AND-gated** with `EventLoopUtilization` (ELU) to reject three false-positive classes documented inline at `:48`:

1. **Isolated GC stalls** — one long pause is one histogram sample, which can't move p99.
2. **Bursty IPC reply storms** — p99 climbs from queueing but ELU stays moderate (loop reaches idle between bursts).
3. **Synchronous native UI work** (file dialogs, window drag, plugin loads) — ELU pegs near 1.0 while V8 sits idle waiting on the OS run loop, so p99 stays low.

A genuine saturation event has **both** high tail latency and high loop occupancy. Constants (`:68`):

| Constant | Value | Role |
| --- | --- | --- |
| `LAG_ENTRY_P99_MS` / `LAG_ENTRY_ELU` | 250 ms / 0.7 | Moderate-entry gate (both must trip) |
| `LAG_ENTER_TICKS_REQUIRED` | 2 (≈10 s) | Sustained-entry confirmation |
| `LAG_ESCALATE_P99_MS` | 500 ms | Severe-spike fast path: enters latch on a single sample (with ELU) |
| `LAG_EXIT_P99_MS` | 150 ms | Per-sample "clean" bar for exit |
| `LAG_EXIT_WINDOW_SAMPLES` / `LAG_EXIT_CLEAN_REQUIRED` | 9 / 7 (45 s, 7-of-9) | Sliding K-of-N exit window — tolerates 2 noisy samples |
| `LAG_PRESSURE_MAX_MS` | 120 000 | Hard cap: force-clears a stuck latch after 2 min |

When the lag latch engages it calls `applyProfile("efficiency")` directly, **bypassing `computeTargetProfile()` and all hysteresis** — saturation needs an immediate reaction. Efficiency entry (lag-driven or score-driven) never destroys cached views: `applyProfile` only freezes them, and renderer destruction is owned exclusively by `evictStaleViews`'s memory-pressure band, which acts on measured free RAM independent of the profile trigger. While the latch is held at `efficiency`, `evaluate()` refuses to upgrade out of it; recovery is owned solely by the lag exit path.

## Profile state machine

Three profiles, asymmetric hysteresis, plus the lag fast path that bypasses it.

```
        upgrade (90s hold)                upgrade (90s hold)
   ┌──────────────────────▶        ┌──────────────────────▶
efficiency               balanced                     performance
   ◀──────────────────────┘        ◀──────────────────────┘
        downgrade (30s hold)              downgrade (30s hold)

  lag fast-path: ──any──▶ efficiency  (immediate, no hold, no upgrade until lag clears)
```

`evaluate()` (`ResourceProfileService.ts:569`) runs each 30 s tick after a 2-tick warm-up (`WARMUP_TICKS`). A target profile must persist as the candidate for a hold window before it applies:

- **`DOWNGRADE_HOLD_MS` = 30 s** — drop toward `efficiency` quickly; protecting the machine is urgent.
- **`UPGRADE_HOLD_MS` = 90 s** — climb back toward `performance` slowly; a brief lull shouldn't undo throttling that's still needed.

Direction is determined by `isUpgrade()` against the order `[efficiency, balanced, performance]`. A candidate that flips before its hold elapses resets the timer.

### Profile config table

Every per-profile knob lives in `RESOURCE_PROFILE_CONFIGS` (`shared/types/resourceProfile.ts:87`). `balanced` values are pinned to the subsystems' historical hardcoded defaults (see the contract comment at `:78`) so enabling the profile system changed nothing on a healthy machine.

| Knob | performance | balanced | efficiency | Consumer |
| --- | --- | --- | --- | --- |
| `pollIntervalActive` / `pollIntervalBackground` (ms) | 1500 / 5000 | 2000 / 10000 | 4000 / 20000 | WorkspaceClient → workspace-host |
| `backgroundGitWatcherCap` | 20 | 12 | 6 | WorkspaceService LRU watcher budget |
| `processTreePollInterval` (ms) | 2000 | 2500 | 5000 | ProcessTreeCache |
| `projectStatsPollInterval` (ms) | 5000 | 5000 | 25000 | ProjectStatsService |
| `webglUpperThreshold` / `webglLowerThreshold` | 14 / 12 | 12 / 10 | 8 / 6 | Renderer TerminalWebGLConfig |
| `fetchIntervalActiveMs` / `fetchIntervalBackgroundMs` | 20 s / 3 min | 30 s / 5 min | 45 s / 10 min | Renderer FetchScheduler |
| `memoryPressureInactiveMs` | 60 min | 30 min | 15 min | HibernationService |
| `paintGateTimeoutMs` / `paintGateHardTimeoutMs` (ms) | 1500 / 4000 | 1500 / 4000 | 2500 / 6000 | ProjectViewManager cold paint gate |
| `warmPaintGateTimeoutMs` / `warmPaintGateHardTimeoutMs` (ms) | 500 / 1500 | 500 / 1500 | 800 / 2500 | ProjectViewManager warm paint gate |

## Fan-out contract

`applyProfile(profile)` (`ResourceProfileService.ts:679`) pushes one config to each consumer. **Every call is wrapped in its own `try/catch`** — a throw from one consumer (or one window's `ProjectViewManager`) must not skip the rest, and on the `efficiency → other` exit path must not block `setEfficiencyFreeze(false)` (leaving renderers frozen after leaving efficiency has no recovery trigger). Multi-window sessions iterate every window's `ProjectViewManager` via `getAllProjectViewManagers()`.

### WorkspaceClient → workspace-host

`updateMonitorConfig(...)` ships the poll/fetch intervals and `backgroundGitWatcherCap` to the workspace host. The watcher cap is an **LRU budget** (`WorkspaceService.applyWatcherBudget`, `:780`): the focused worktree always keeps its recursive watcher (excluded from the cap); the `cap` most-recently-focused background worktrees keep `git-only` watchers; the rest fall back to adaptive polling. Revocations run before grants so freed inotify/FSEvents handles are released before any new watcher arms — the live handle count stays bounded by the cap even mid-reconcile. This is the mechanism that bounds O(N) fd growth in long sessions with many worktrees.

### HibernationService

`setMemoryPressureThresholdMs(config.memoryPressureInactiveMs)` tunes the **memory-pressure** hibernation path only (`HibernationService.ts:57`). There are two independent idle paths:

- **Scheduled idle** — `inactiveThresholdHours` (default 24 h), user-configurable, profile-independent.
- **Memory-pressure** — `hibernateUnderMemoryPressure()` (`:267`), invoked by `ProcessMemoryMonitor`'s tier-2 mitigation (`ProcessMemoryMonitor.ts:581`, wired through `globalServicesInit.ts:550`). It hibernates non-current projects idle longer than `memoryPressureInactiveMs`, skipping any project with an active agent (`ACTIVE_AGENT_STATES`) or an in-flight git operation. The profile makes this threshold stricter under pressure (15 min on `efficiency` vs 60 min on `performance`).

`ProcessMemoryMonitor` applies tier 1 once at the start of a pressure episode, then at most once per five minutes while the same episode persists. Tier 1 trims PTY-host state and hidden browser/dev-preview webviews; it never clears caches or forces GC in the visible renderer. Tier 2 requires three consecutive pressure samples, rechecks the originating system-memory signal after tier 1, and is limited to once per ten minutes. It destroys hidden webviews, evicts cached project renderers down to the active view, and runs memory-pressure hibernation. A clean sample resets the episode so a later independent event can react immediately.

### PtyClient → ResourceGovernor (cross-process)

`PtyClient.setResourceProfile(profile)` forwards the profile to the PTY host, where `ResourceGovernor.setResourceProfile()` (`ResourceGovernor.ts:103`) swaps its threshold set. The governor watches V8 heap utilization (`heapUsed / heap_size_limit`) every 2 s, smoothed with an EMA (`α = 2/11`, ~20 s window, `:59`) to reject single-tick GC sawtooth:

#### Cross-isolate accounting (analysis workers)

`process.memoryUsage()` is **isolate-scoped**: it reports the calling thread's V8 heap and external memory only. When #10920 moved the per-terminal `@xterm/headless` mirrors into the analysis `worker_threads`, the process's dominant memory consumer (~12 bytes/cell; a filled 10 000-line × 120-col mirror measures ≈18 MB) moved into isolates the governor's own reading cannot see — a 24-terminal fleet can hold ~440 MB that reads as ~0 % utilization. The governor was blind to exactly this class once before (#9905, heap-only vs `external`); the worker migration recreated it one level up.

The accounting loop closes it: each worker's `AnalysisWorkerRuntime` self-samples `process.memoryUsage()` (isolate-scoped **inside** the worker, so it sees the mirrors) plus per-session actual buffer occupancy every 2 s on an unref'd timer, and posts a `memory-sample` message. `AnalysisWorkerPool` caches the latest sample per slot — fenced by worker instance identity, cleared on exit/respawn so a fresh worker never inherits its predecessor's numbers — and exposes `getMemoryAccounting()`. The governor folds fresh samples (≤10 s old; stale or dead-slot samples contribute 0, same discipline as the profile service's terminal-workload signal) into its utilization max: combined host + worker memory against the total process budget, plus the heaviest single worker's heap against the per-isolate `--max-old-space-size` cap that workers inherit via `execArgv`. The same samples upgrade the targeted pre-pause trim and the `buffer-memory-gauge` from configured-cap estimates to actual occupancy — a capped-at-10 000 terminal holding 40 real lines contributes nothing and keeps its history. In in-thread analysis mode there are no samples and the base signal is already correct (the mirrors live in the host isolate). The samples also populate the `memory` field of the pool's `WorkerResourceSnapshot`s, so diagnostics bundles carry per-worker isolate memory.

| Threshold       | default   | efficiency |
| --------------- | --------- | ---------- |
| Engage (pause)  | 85%       | 70%        |
| Resume          | 60%       | 50%        |
| Warning / clear | 70% / 65% | 55% / 45%  |

Engage is gated by warm-up (5 ticks) and a 30 s re-engage cooldown after any force-resume (prevents the pause/resume flap of #8616). **Critical pressure (≥95% raw) bypasses both** — the next allocation could OOM the host. Before pausing in the non-critical path, the governor runs a one-shot targeted reclaim: it ranks terminals by an `scrollbackLines × cols × 12`-byte estimate of their headless buffer and trims only the heaviest contributors (those above `SCROLLBACK_MIN`) to the minimum, leaving quiet terminals' history intact (`trimBuffersTargeted`); if buffer-size attribution isn't wired it falls back to the uniform `trimBuffers()` flatten. The same per-terminal estimate is emitted every warning-band tick as the advisory `buffer-memory-gauge` reliability metric. If pressure persists a tick later it pauses. Pause/resume order is triaged idle-first / active-agent-last (resume reverses it), but the pause loop runs synchronously within one tick — the ordering affects only intra-tick sequencing, not observable runway, so a working agent is not spared a pause that fires this tick. At critical pressure the triage is skipped and every terminal is paused immediately. Paused terminals emit the `paused-resource-governor` flow status; on resume they revert to `running` (or restore `paused-backpressure` if the backpressure token is still held). See [terminal-lifecycle.md](./terminal-lifecycle.md) for the full flow-status state set and pause-token coordination.

### WorkerGovernanceService — persistent workers and utility hosts

`WorkerGovernanceService` (`electron/services/WorkerGovernanceService.ts`) is the bounded resource story for every persistent worker introduced by #10920: the analysis worker pool (pty-host `worker_threads`), the DB maintenance worker, the copytree worker (workspace-host `worker_thread`), per-plugin utility-process workers, and the utility hosts themselves. Each subsystem registers a provider that reports the shared `WorkerResourceSnapshot` shape (`shared/types/workerGovernance.ts`): identity, alive/queue/session counts, last-activity, memory where attributable, and — critically — an eligibility declaration (`trim`/`dispose`/`restart`) that the pure policy layer (`shared/utils/workerGovernancePolicy.ts`) never overrides upward.

Two consumers: `DiagnosticsCollector`'s `workerGovernance` section (support bundles) plus a compact `workers` summary in the why-slow snapshot, and the efficiency-entry trim fan-out. On each entry into `efficiency`, `applyProfile` fires `requestWorkerTrim` (same per-consumer try/catch isolation as every other fan-out target); the service applies a 5-minute cooldown so profile flapping can never become its own churn source, then asks each provider to trim within its own safety gates:

- **Analysis pool** — rides the existing `set-resource-profile` push instead of the main-side fan-out: on efficiency entry the pty-host runs a one-shot `PtyManager.trimIdleAnalysisSessions()` pass that shrinks the headless scrollback of terminals idle past 10 minutes with no agent in `ACTIVE_AGENT_STATES` (the same protection set as eviction/hibernation). The heap-driven `ResourceGovernor` trims remain the in-host backstop. Request/response traffic to the pool carries a per-slot worker **generation** echoed on every reply, so a reply from a superseded worker instance resolves empty instead of delivering stale content — the request-path counterpart of the data-path feed epoch.
- **Plugin workers** — `PluginService.disposeIdlePluginWorkers()` disposes workers of plugins idle ≥30 minutes through a narrow deactivation path (worker + imperative registrations torn down; the plugin and its manifest contributions stay loaded, so the next dispatch/panel-open/forge pull lazily re-forks, mirroring the dev-reload cycle). The gate is deliberately conservative: builtins, dev workers, panel or MCP contributions, startup activation, live event subscriptions, pending invokes, managed processes, and fs watchers all disqualify.
- **DB worker** — report-only, permanently. Its FIFO queue carries write ordering, the `user_version` fence assumes only crash/shutdown teardown, and shutdown draining (cleanup → DB maintenance → close) already owns its lifecycle.
- **Copytree worker** — report-only for trims; result buffers already release at transfer (pending-map entries are the only retention and are deleted on resolve), and a worker-generation fence at the message listener drops stale results from a dead worker instance.

**Restarts never happen.** No subsystem declares restart eligibility because persistent `worker_threads` must not be terminate/recreate cycled (Electron 37+ `!flush_tasks_` crash), and the policy additionally requires zero in-flight work, a long idle window, a per-worker cooldown, and no crash-loop before it would ever say "restart" — the guardrail is structural, not advisory.

### ProjectViewManager — freeze + LRU eviction + paint gate

`ProjectViewManager` (`electron/window/ProjectViewManager.ts`) is the **most-involved** consumer; it owns three independent profile-driven behaviors. (Each project gets its own `WebContentsView` with an independent V8 context — see the multi-window/per-view notes in [docs/development.md](../development.md) and [vision.md](../vision.md).)

**1. CDP freeze of cached views** — `setEfficiencyFreeze(true)` on efficiency entry, `(false)` on exit. Freezing puts cached (non-active) views into Chromium's `frozen` web-lifecycle state via CDP (`freezeWebContents` → `Page.setWebLifecycleState`, `electron/utils/webContentsLifecycle.ts:78`), suppressing timer wake-ups on top of background throttling. The active view is never frozen.

> **Asymmetry — freeze is debounced, unfreeze is immediate** (`ProjectViewManager.ts:722`, `EFFICIENCY_FREEZE_DEBOUNCE_MS = 500`). The lag fast path can flip efficiency on/off without the 30 s downgrade hysteresis, so a single spike-and-recover would otherwise freeze every cached view for no observable benefit — the 500 ms trailing-edge debounce absorbs that. Unfreeze runs immediately because keeping a view frozen after deciding to leave efficiency is the worst of both worlds (no resource saving, plus a stale renderer).

**2. Cached-view LRU eviction** — cached `WebContentsView`s cost ~100–500 MB RSS each (a full Chromium renderer), so they're the largest reclaimable chunk. Two controls:

- Efficiency entry never lowers the cached-view cap — all efficiency triggers (memory, battery, thermal, CPU, lag) are handled by freezing alone, and destroying renderers is reserved for the low-memory floor below. On exit the limit is re-asserted to `getUserCachedViewLimit()` (the user's `cachedProjectViews` setting, default 1) so a stale clamp can never outlive the profile.
- `setMemoryPressurePolicy({ criticalMb, warningMb })` — the cached-view reclaim band, pushed **once per PVM** at `start()` / `applyCurrentProfileTo()` and deliberately **not** on transitions. Both edges come from `getSystemMemoryThresholds(totalRamMb)`, the same thresholds that promote the profile on the memory signal, so a promotion and the reclaim it implies arm at the same reading. Keeping it off the transition path is what stops the interactive `efficiency → balanced` clamp from loosening the floor at the exact moment memory is lowest (#11469). Inside `evictStaleViews` the band is a per-pass target that **never mutates** the user's `maxCachedViews`:
  - **above `warningMb`** — no override; the user's cap stands.
  - **`[criticalMb, warningMb)`** — soft band. The settled cap steps down one view per equal slice of the band, and the pass destroys **at most one view**, so reclaim starts a full band-width earlier and degrades warm switching gradually. Soft contraction runs **only** from the periodic sweep (`maybeEvictUnderPressure`, gated at the _warning_ edge), making the 30 s sampler cadence the settling interval between steps; `"lru"` and `"limit-change"` passes stay deterministic at the configured cap.
  - **below `criticalMb`** — critical. `effectiveMax` clamps to 1 in a single pass, exactly as it did before #11469, and only here (or under the forced tier-2 reclaim) do assistant-protected views rejoin the candidate pool.

  Eviction order is **pure LRU** — memory size is logged but never drives eviction order, because the largest renderer is usually the project the user is actively working in (#8602). The outgoing view of an open paint gate is treated as non-evictable so a mid-gate `setCachedViewLimit(1)` can't expose an unpainted frame. Re-entering an evicted project cold-starts a fresh view; `evictionTimestamps` records when each projectId was last evicted for revival-timing telemetry (`:335`). `setLowMemoryFreeThresholdMb(mb | null)` is retained as the E2E escape hatch: `null` disables reclaim entirely, and a positive value collapses the band to a single cliff.

**3. Paint-gate timeouts** — `paintGateTimeoutMs` (soft) and `paintGateHardTimeoutMs` (hard) bound the anti-flash hand-off when switching project views; `warmPaintGateTimeoutMs` / `warmPaintGateHardTimeoutMs` are the warm-reactivation equivalents, bounding the wait for the cached view's wake fan-out (atlas repair + missed-buffer replay) to signal `APP_VIEW_WARM_PAINTED`. The soft bounds only log a warning; the hard bounds force-detach the outgoing view assuming the incoming renderer is stuck. All stretch under `efficiency` (cold 2.5 s / 6 s vs 1.5 s / 4 s; warm 0.8 s / 2.5 s vs 0.5 s / 1.5 s) because both cold starts and wake fan-outs run measurably slower under memory/thermal/battery pressure — without the stretch, degraded hardware would spam false-timeout warnings and drop the warm bridge mid-repaint.

> `start()` pushes the memory-pressure band and the initial profile's paint-gate values to every PVM on launch (`:248`), so the config table is the single source of truth even when the service stays on its default `balanced` and `applyProfile()` never runs.

### ProjectStatsService

`updatePollInterval(config.projectStatsPollInterval)` — 5 s on performance/balanced, 25 s on efficiency.

### Note on PortalManager and ProcessMemoryMonitor

`PortalManager` runs its own LRU eviction (`evictIfNeeded`, `electron/services/PortalManager.ts:97`) but does **not** read the resource profile — it's a parallel, profile-independent budget. `ProcessMemoryMonitor` is the other half of the memory story: it polls per-process footprint on a 30 s cadence and runs a two-tier mitigation (clear caches / destroy hidden webviews → hibernate idle projects), independent of the profile state machine. The profile service and `ProcessMemoryMonitor` observe overlapping signals but act through different levers.

## Reaching the renderer

On every `applyProfile`, the service broadcasts `resource:profile-changed` with `{ profile, config }` (`ResourceProfileService.ts:810`). In the renderer:

- `useResourceProfile()` (`src/hooks/useResourceProfile.ts`) subscribes via `window.electron.system.onResourceProfileChanged`, mounted once in `App.tsx`. It applies WebGL thresholds (`setWebglThresholds` + `terminalInstanceService.refreshWebGLMode()`) and writes the profile + fetch intervals into the store.
- `useResourceProfileStore` (`src/store/resourceProfileStore.ts`) holds `profile`, `fetchIntervalActiveMs`, `fetchIntervalBackgroundMs`. Worktree cards (`MainWorktreeSecondaryRow`, `NonMainSecondaryRow`) read the fetch intervals to scale per-card git-status fetch cadence by focus.

What each profile actually changes in the renderer: **WebGL DOM/GPU mode thresholds** (efficiency flips terminals to DOM-mode renderer sooner, where each WebGL context is comparatively more expensive on constrained hardware, staying below Chromium's per-renderer context cap) and **FetchScheduler intervals**. The `config` payload also carries the main-process knobs, but those are applied main-side; the renderer reads only WebGL + fetch fields.

## Relationship to the Tier-1 ambient-signal model

Resource governance is deliberately **quiet**. Per `CLAUDE.md`'s runtime-signal tiers, the auto-recovering pause states (`paused-resource-governor`, `paused-backpressure`) sit at **Tier 1 — ambient indicator**: the flow-status pill in `TerminalHeaderContent.tsx` shows the state on pane chrome, no toast. They recover on their own (buffer drains / memory eases), so escalating would only train users to ignore the signal. A state that stays in auto-recovery beyond ~30 s without progress, or exhausts retries, is what `CLAUDE.md` says to promote to a Tier-3 inline error banner — but the steady-state resource-governance signals never reach the user as anything louder than chrome. The profile itself is silent: there is no toast on a profile transition, only a logged `resource-profile-changed` event.

## Where to look

| Concern | File |
| --- | --- |
| Profile state machine, signals, lag monitor, fan-out | `electron/services/ResourceProfileService.ts` |
| Profile config table + types | `shared/types/resourceProfile.ts` |
| Composite memory snapshot (Electron + terminal-workload slices, freshness) | `electron/services/memoryAccounting.ts`, `shared/types/memoryAccounting.ts` |
| PTY-host heap governor (cross-process) | `electron/pty-host/ResourceGovernor.ts` |
| Worker-governance aggregation + trim fan-out | `electron/services/WorkerGovernanceService.ts` |
| Worker snapshot shape + pure policy | `shared/types/workerGovernance.ts`, `shared/utils/workerGovernancePolicy.ts` |
| Idle analysis-session trim (pty-host) | `electron/services/PtyManager.ts`, `electron/pty-host/handlers/resourceConfig.ts` |
| Idle plugin-worker dispose | `electron/services/PluginService.ts` (`disposeIdlePluginWorkers`) |
| View freeze / LRU eviction / paint gate | `electron/window/ProjectViewManager.ts` |
| CDP freeze + CPU-throttle helpers | `electron/utils/webContentsLifecycle.ts` |
| Memory-pressure hibernation | `electron/services/HibernationService.ts` |
| Per-process memory mitigation tiers | `electron/services/ProcessMemoryMonitor.ts` |
| Background git-watcher LRU budget | `electron/workspace-host/WorkspaceService.ts` |
| Service wiring (deps, instantiation) | `electron/window/globalServicesInit.ts` |
| Renderer store + hook | `src/store/resourceProfileStore.ts`, `src/hooks/useResourceProfile.ts` |

## Related docs

- [terminal-lifecycle.md](./terminal-lifecycle.md) — flow-status states (`paused-resource-governor`, `paused-backpressure`) and pause-token coordination.
- [development.md](../development.md) — service registry, multi-window / per-view (`WebContentsView`) architecture.
- [vision.md](../vision.md) — why adaptive resource governance is a strategic frontier as agent counts grow.
