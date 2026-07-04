# Adaptive resource governance (profiles, pressure, eviction, hibernation)

## Purpose

Running 5–10 agents — each with its own dev server, terminal, and Chromium renderer — puts real pressure on a developer's machine. Daintree adapts to that pressure instead of running flat-out: a single main-process service (`ResourceProfileService`) watches a handful of system signals, collapses them into one of three coarse **profiles** (`performance` / `balanced` / `efficiency`), and fans that profile out to ~7 subsystems that each tighten or loosen their own knobs. A separate, cross-process governor (`ResourceGovernor`, in the PTY host) handles the hard, fast case — imminent OOM — by pausing terminal output directly.

This doc is the map for that machinery: the signals, the profile state machine and its hysteresis, the fan-out contract per consumer, and how the profile reaches the renderer.

## Mental model

Two loops, different time constants:

- **Slow loop — `ResourceProfileService`** (`electron/services/ResourceProfileService.ts`, ~818 LOC). Runs in the main process on a 30 s aligned interval. Aggregates memory, thermal, battery, CPU-speed-limit, fleet-size, and system-available-memory signals into a `pressureScore`, maps the score to a profile, applies asymmetric hysteresis, and pushes the resulting `ResourceProfileConfig` to every consumer. This is **policy** — it changes cadences and budgets, never pauses anyone.
- **Fast loop — `ResourceGovernor`** (`electron/pty-host/ResourceGovernor.ts`, ~525 LOC). Runs in the **PTY host process** on a 2 s interval, watching its own V8 heap. When the heap approaches its limit it pauses terminal output (the `paused-resource-governor` flow state) and resumes when pressure clears. The profile service feeds it one input — `setResourceProfile(profile)` — which lowers the governor's thresholds under `efficiency`; otherwise the governor is autonomous.

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

`computeTargetProfile()` (`ResourceProfileService.ts:601`) sums a `pressureScore` from these signals. All thresholds that compare against physical RAM are expressed as **fractions of `os.totalmem()`** so an 8 GB and a 64 GB machine behave sensibly without per-device tuning.

| Signal | Source | Contribution to `pressureScore` |
| --- | --- | --- |
| App-private memory | `app.getAppMetrics()`, summed `memory.workingSetSize` | `+2` above `HIGH_FRACTION` (0.15 × RAM), `+1` above `LOW_FRACTION` (0.08 × RAM) |
| Battery | `powerMonitor.isOnBatteryPower()` + `on-battery`/`on-ac` events | `+1` while on battery |
| Thermal (macOS only) | `powerMonitor` `thermal-state-change` + `getCurrentThermalState()` | `+2` critical, `+1` serious |
| CPU speed limit (macOS & Windows) | `powerMonitor` `speed-limit-change` | `+2` below 50, `+1` below 100 |
| Active-agent fleet size | cached count from `PtyClient.getAllTerminalsAsync()`, filtered | `+3` ≥ 24, `+2` ≥ 16, `+1` ≥ 8 |
| System-available memory | `process.getSystemMemoryInfo()` (free + purgeable on macOS, free elsewhere) | `+2` below 0.1 × RAM, `+1` below 0.2 × RAM |

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

When the lag latch engages it calls `applyProfile("efficiency")` directly, **bypassing `computeTargetProfile()` and all hysteresis** — saturation needs an immediate reaction. Efficiency entry (lag-driven or score-driven) never destroys cached views: `applyProfile` only freezes them, and renderer destruction is owned exclusively by `evictStaleViews`'s `lowMemoryFreeThresholdMb` floor, which acts on measured free RAM independent of the profile trigger. While the latch is held at `efficiency`, `evaluate()` refuses to upgrade out of it; recovery is owned solely by the lag exit path.

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
| `lowMemoryFreeThresholdMb` | `null` | 768 | 1024 | ProjectViewManager eviction floor |
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

### PtyClient → ResourceGovernor (cross-process)

`PtyClient.setResourceProfile(profile)` forwards the profile to the PTY host, where `ResourceGovernor.setResourceProfile()` (`ResourceGovernor.ts:103`) swaps its threshold set. The governor watches V8 heap utilization (`heapUsed / heap_size_limit`) every 2 s, smoothed with an EMA (`α = 2/11`, ~20 s window, `:59`) to reject single-tick GC sawtooth:

| Threshold       | default   | efficiency |
| --------------- | --------- | ---------- |
| Engage (pause)  | 85%       | 70%        |
| Resume          | 60%       | 50%        |
| Warning / clear | 70% / 65% | 55% / 45%  |

Engage is gated by warm-up (5 ticks) and a 30 s re-engage cooldown after any force-resume (prevents the pause/resume flap of #8616). **Critical pressure (≥95% raw) bypasses both** — the next allocation could OOM the host. Before pausing in the non-critical path, the governor runs a one-shot targeted reclaim: it ranks terminals by an `scrollbackLines × cols × 12`-byte estimate of their headless buffer and trims only the heaviest contributors (those above `SCROLLBACK_MIN`) to the minimum, leaving quiet terminals' history intact (`trimBuffersTargeted`); if buffer-size attribution isn't wired it falls back to the uniform `trimBuffers()` flatten. The same per-terminal estimate is emitted every warning-band tick as the advisory `buffer-memory-gauge` reliability metric. If pressure persists a tick later it pauses. Pause/resume order is triaged idle-first / active-agent-last (resume reverses it), but the pause loop runs synchronously within one tick — the ordering affects only intra-tick sequencing, not observable runway, so a working agent is not spared a pause that fires this tick. At critical pressure the triage is skipped and every terminal is paused immediately. Paused terminals emit the `paused-resource-governor` flow status; on resume they revert to `running` (or restore `paused-backpressure` if the backpressure token is still held). See [terminal-lifecycle.md](./terminal-lifecycle.md) for the full flow-status state set and pause-token coordination.

### ProjectViewManager — freeze + LRU eviction + paint gate

`ProjectViewManager` (`electron/window/ProjectViewManager.ts`) is the **most-involved** consumer; it owns three independent profile-driven behaviors. (Each project gets its own `WebContentsView` with an independent V8 context — see the multi-window/per-view notes in [docs/development.md](../development.md) and [vision.md](../vision.md).)

**1. CDP freeze of cached views** — `setEfficiencyFreeze(true)` on efficiency entry, `(false)` on exit. Freezing puts cached (non-active) views into Chromium's `frozen` web-lifecycle state via CDP (`freezeWebContents` → `Page.setWebLifecycleState`, `electron/utils/webContentsLifecycle.ts:78`), suppressing timer wake-ups on top of background throttling. The active view is never frozen.

> **Asymmetry — freeze is debounced, unfreeze is immediate** (`ProjectViewManager.ts:722`, `EFFICIENCY_FREEZE_DEBOUNCE_MS = 500`). The lag fast path can flip efficiency on/off without the 30 s downgrade hysteresis, so a single spike-and-recover would otherwise freeze every cached view for no observable benefit — the 500 ms trailing-edge debounce absorbs that. Unfreeze runs immediately because keeping a view frozen after deciding to leave efficiency is the worst of both worlds (no resource saving, plus a stale renderer).

**2. Cached-view LRU eviction** — cached `WebContentsView`s cost ~100–500 MB RSS each (a full Chromium renderer), so they're the largest reclaimable chunk. Two controls:

- Efficiency entry never lowers the cached-view cap — all efficiency triggers (memory, battery, thermal, CPU, lag) are handled by freezing alone, and destroying renderers is reserved for the low-memory floor below. On exit the limit is re-asserted to `getUserCachedViewLimit()` (the user's `cachedProjectViews` setting, default 1) so a stale clamp can never outlive the profile.
- `setLowMemoryFreeThresholdMb(config...)` pushed on **every** transition. Inside `evictStaleViews` (`:1377`) this is a per-pass floor: when system-available RAM drops below it, `effectiveMax` clamps to 1 for that pass **without mutating** the user's `maxCachedViews`, so the user's setting takes effect again as soon as pressure subsides. Eviction order is **pure LRU** — memory size is logged but never drives eviction order, because the largest renderer is usually the project the user is actively working in (#8602). The outgoing view of an open paint gate is treated as non-evictable so a mid-gate `setCachedViewLimit(1)` can't expose an unpainted frame. Re-entering an evicted project cold-starts a fresh view; `evictionTimestamps` records when each projectId was last evicted for revival-timing telemetry (`:335`).

**3. Paint-gate timeouts** — `paintGateTimeoutMs` (soft) and `paintGateHardTimeoutMs` (hard) bound the anti-flash hand-off when switching project views; `warmPaintGateTimeoutMs` / `warmPaintGateHardTimeoutMs` are the warm-reactivation equivalents, bounding the wait for the cached view's wake fan-out (atlas repair + missed-buffer replay) to signal `APP_VIEW_WARM_PAINTED`. The soft bounds only log a warning; the hard bounds force-detach the outgoing view assuming the incoming renderer is stuck. All stretch under `efficiency` (cold 2.5 s / 6 s vs 1.5 s / 4 s; warm 0.8 s / 2.5 s vs 0.5 s / 1.5 s) because both cold starts and wake fan-outs run measurably slower under memory/thermal/battery pressure — without the stretch, degraded hardware would spam false-timeout warnings and drop the warm bridge mid-repaint.

> `start()` pushes the initial profile's `lowMemoryFreeThresholdMb` and paint-gate values to every PVM on launch (`:248`), so the config table is the single source of truth even when the service stays on its default `balanced` and `applyProfile()` never runs.

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
| PTY-host heap governor (cross-process) | `electron/pty-host/ResourceGovernor.ts` |
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
