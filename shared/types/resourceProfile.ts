export type ResourceProfile = "performance" | "balanced" | "efficiency";

export interface ResourceProfileConfig {
  /** Workspace-host active worktree polling interval (ms) */
  pollIntervalActive: number;
  /** Workspace-host background worktree polling interval (ms) */
  pollIntervalBackground: number;
  /**
   * Maximum number of background worktrees allowed to hold a `git-only`
   * file watcher concurrently, per workspace-host (per project view). The
   * focused worktree always gets its (recursive) watcher and is excluded
   * from this budget. Background worktrees beyond the cap fall back to the
   * adaptive poll path. Bounds the O(N) inotify/FSEvents/fd growth that long
   * sessions with many worktrees would otherwise produce. Smaller under
   * efficiency to maximize headroom on constrained hardware.
   */
  backgroundGitWatcherCap: number;
  /** ProcessTreeCache polling interval (ms) */
  processTreePollInterval: number;
  /** ProjectStatsService polling interval (ms) */
  projectStatsPollInterval: number;
  /**
   * Upper threshold for the WebGL mode switch. When the count of terminals
   * wanting WebGL exceeds this value, every active context is released and
   * the manager flips to DOM-mode. Kept a headroom margin below the effective
   * per-renderer WebGL-context ceiling (RAM-tiered via the
   * `max-active-webgl-contexts` switch) so devtools and other in-renderer
   * WebGL consumers still have room. Not stored in RESOURCE_PROFILE_CONFIGS —
   * resolved from the ceiling on the main process (see
   * electron/utils/resourceProfileConfig.ts, #11192).
   */
  webglUpperThreshold: number;
  /**
   * Lower threshold for the WebGL mode switch. Once the count drops to this
   * value or below, the manager flips back to WebGL-mode and re-attaches an
   * addon to every want via a rAF-staggered drain. The gap between upper and
   * lower is the hysteresis band — opening/closing one panel at the boundary
   * will not flap the fleet. Resolved from the ceiling alongside
   * webglUpperThreshold (see webglUpperThreshold).
   */
  webglLowerThreshold: number;
  /**
   * Ceiling on the agent-terminal scrollback policy (lines). Caps the
   * AGENT_POLICY maxLines in src/utils/scrollbackConfig.ts — at xterm's
   * ~1.2KB/line each agent terminal holds up to ~maxLines×1.2KB of buffer
   * once filled, so constrained hardware (efficiency) trades history depth
   * for ~3MB per visible agent terminal. Applied live on profile change via
   * useResourceProfile → restoreScrollbackAllForeground.
   */
  agentScrollbackMaxLines: number;
  /** FetchScheduler focused (isCurrent) fetch interval (ms) */
  fetchIntervalActiveMs: number;
  /** FetchScheduler background (non-current) fetch interval (ms) */
  fetchIntervalBackgroundMs: number;
  /**
   * PortBatcher throughput-mode flush window (ms) in the pty-host. Each busy
   * terminal's batched output flushes on this cadence, so it bounds the
   * steady-state timer-wakeup + MessagePort-post rate under multi-agent
   * output floods. Stretched under efficiency, where the extra output
   * latency is an acceptable trade for fewer wakeups on constrained
   * hardware; the 64KB sync-flush threshold still bounds buffering under
   * very high aggregate rates.
   */
  portBatchThroughputDelayMs: number;
  /** HibernationService memory-pressure inactivity threshold (ms) */
  memoryPressureInactiveMs: number;
  /**
   * Available system memory (MB) below which ProjectViewManager clamps its
   * effective cached-view limit to 1 for the current eviction pass. `null`
   * disables the override (the user-configured cachedProjectViews limit stays
   * authoritative). "Available" on macOS means free + purgeable; on other
   * platforms it is free alone.
   */
  lowMemoryFreeThresholdMb: number | null;
  /**
   * Cold-start paint-gate SOFT timeout (ms). Bounds the wait for the incoming
   * project view's renderer to emit `APP_VIEW_PAINTED`. Crossing this bound
   * does NOT detach the outgoing view — it only logs a warning so the gate
   * tail is observable; the outgoing view stays attached until either the
   * paint signal arrives or the hard timeout fires. Tuned per profile because
   * cold starts run measurably slower under memory/thermal/battery pressure
   * (efficiency).
   */
  paintGateTimeoutMs: number;
  /**
   * Cold-start paint-gate HARD timeout (ms). Last-resort ceiling that
   * deactivates the outgoing view even without a paint signal — assumes the
   * incoming renderer is stuck or crashed. Should be comfortably above
   * `paintGateTimeoutMs` so legitimately slow cold starts complete via the
   * signal path instead of falling through.
   */
  paintGateHardTimeoutMs: number;
  /**
   * Warm-reactivation paint-gate SOFT timeout (ms). Bounds the wait for a
   * cached view's renderer to finish its wake fan-out (atlas repair +
   * missed-buffer replay across the grid) and emit `APP_VIEW_WARM_PAINTED`.
   * Crossing it only logs; the bridge view stays attached until the signal
   * or the hard timeout.
   */
  warmPaintGateTimeoutMs: number;
  /**
   * Warm-reactivation paint-gate HARD timeout (ms). Ceiling that drops the
   * bridge view even without a paint signal. Should stay comfortably above
   * `warmPaintGateTimeoutMs` so slow-but-live wake fan-outs complete via the
   * signal path instead of revealing a partially repainted grid.
   */
  warmPaintGateHardTimeoutMs: number;
}

/**
 * Host-independent slice of ResourceProfileConfig — everything except the
 * WebGL flip thresholds, which are RAM-dependent and resolved on the main
 * process (electron/utils/resourceProfileConfig.ts). RESOURCE_PROFILE_CONFIGS
 * is typed as this so a stale literal WebGL threshold can never be read off the
 * static table again; the full config is only ever assembled by the resolver
 * (#11192).
 */
export type BaseResourceProfileConfig = Omit<
  ResourceProfileConfig,
  "webglUpperThreshold" | "webglLowerThreshold"
>;

export interface ResourceProfilePayload {
  profile: ResourceProfile;
  config: ResourceProfileConfig;
}

/** Thermal pressure reported by the OS power monitor (macOS only; "unknown" elsewhere). */
export type ResourceThermalState = "unknown" | "nominal" | "fair" | "serious" | "critical";

/**
 * Read-only projection of the active resource profile and the host-pressure
 * inputs that drive it. Surfaced in the diagnostics export (#10500) and over
 * MCP (#10683) so an orchestrator can observe machine pressure before
 * dispatching work. The scoring internals (histograms, thresholds, candidate
 * timers) stay private to ResourceProfileService.
 */
export interface ResourceProfileSnapshot {
  /** The profile currently in effect. */
  profile: ResourceProfile;
  /** Latest OS thermal pressure reading. */
  thermalState: ResourceThermalState;
  /** Whether the machine is running on battery power. */
  isOnBattery: boolean;
  /** CPU speed-limit percentage reported by the OS (0–100; 100 = unthrottled). */
  speedLimit: number;
  /** Whether sustained event-loop-lag mitigation is currently latched. */
  lagPressureActive: boolean;
}

/**
 * Profile configurations.
 * "balanced" values MUST match today's hardcoded defaults exactly:
 * - pollIntervalActive: 2000 (WorkspaceService DEFAULT_ACTIVE_WORKTREE_INTERVAL_MS)
 * - pollIntervalBackground: 10000 (WorkspaceService DEFAULT_BACKGROUND_WORKTREE_INTERVAL_MS)
 * - processTreePollInterval: 2500 (ProcessTreeCache constructor default)
 * - projectStatsPollInterval: 5000 (ProjectStatsService DEFAULT_POLL_INTERVAL_MS)
 * - memoryPressureInactiveMs: 1800000 (HibernationService MEMORY_PRESSURE_INACTIVE_MS = 30min)
 *
 * The WebGL flip thresholds (webglUpperThreshold / webglLowerThreshold) are NOT
 * stored here: they are RAM-dependent and resolved from the effective
 * per-renderer WebGL-context ceiling on the main process
 * (electron/utils/resourceProfileConfig.ts). The table is therefore typed
 * `BaseResourceProfileConfig` and the full config is only ever assembled by the
 * resolver (#11192).
 */
export const RESOURCE_PROFILE_CONFIGS: Record<ResourceProfile, BaseResourceProfileConfig> = {
  performance: {
    pollIntervalActive: 1500,
    pollIntervalBackground: 5000,
    backgroundGitWatcherCap: 20,
    processTreePollInterval: 2000,
    projectStatsPollInterval: 5000,
    memoryPressureInactiveMs: 60 * 60 * 1000, // 60 min
    lowMemoryFreeThresholdMb: null,
    agentScrollbackMaxLines: 5000,
    fetchIntervalActiveMs: 20_000,
    fetchIntervalBackgroundMs: 3 * 60_000,
    portBatchThroughputDelayMs: 16,
    paintGateTimeoutMs: 1_500,
    paintGateHardTimeoutMs: 4_000,
    warmPaintGateTimeoutMs: 500,
    warmPaintGateHardTimeoutMs: 1_500,
  },
  balanced: {
    pollIntervalActive: 2000,
    pollIntervalBackground: 10000,
    backgroundGitWatcherCap: 12,
    processTreePollInterval: 2500,
    projectStatsPollInterval: 5000,
    memoryPressureInactiveMs: 30 * 60 * 1000, // 30 min
    lowMemoryFreeThresholdMb: 768,
    agentScrollbackMaxLines: 5000,
    fetchIntervalActiveMs: 30_000,
    fetchIntervalBackgroundMs: 5 * 60_000,
    // Must match PORT_BATCH_THROUGHPUT_DELAY_MS — the pty-host's fallback
    // until the first set-resource-profile push lands.
    portBatchThroughputDelayMs: 16,
    // Balanced paint-gate values (cold and warm) must match the
    // `DEFAULT_*_PAINT_GATE_*_MS` constants in
    // `electron/window/ProjectViewManager.ts` — those constants are the
    // fallback used until the profile push lands. Keep them in lockstep.
    paintGateTimeoutMs: 1_500,
    paintGateHardTimeoutMs: 4_000,
    warmPaintGateTimeoutMs: 500,
    warmPaintGateHardTimeoutMs: 1_500,
  },
  efficiency: {
    pollIntervalActive: 4000,
    pollIntervalBackground: 20000,
    backgroundGitWatcherCap: 6,
    processTreePollInterval: 5000,
    projectStatsPollInterval: 25000,
    memoryPressureInactiveMs: 15 * 60 * 1000, // 15 min
    lowMemoryFreeThresholdMb: 1024,
    // Half the agent history ceiling on constrained hardware — ~3MB less
    // buffer headroom per filled agent terminal, consistent with the
    // efficiency profile's other fidelity trades.
    agentScrollbackMaxLines: 2500,
    fetchIntervalActiveMs: 45_000,
    fetchIntervalBackgroundMs: 10 * 60_000,
    // ~2.5x fewer flush wakeups and MessagePort posts per busy terminal; the
    // added 24ms worst-case output latency is invisible next to the pressure
    // (thermal/battery/CPU) that put the app in efficiency.
    portBatchThroughputDelayMs: 40,
    // Cold starts under memory/thermal/battery pressure routinely run slower
    // than the perf/balanced 1.5s soft bound — keeping efficiency at a 2x
    // headroom preserves the anti-flash hand-off without false-timeout
    // warning spam on degraded hardware.
    paintGateTimeoutMs: 2_500,
    paintGateHardTimeoutMs: 6_000,
    // The warm gate waits on the full wake fan-out (atlas repair + buffer
    // replay per terminal at concurrency 2), which routinely outlasts the
    // perf/balanced 1.5s ceiling on degraded hardware — same headroom
    // rationale as the cold-gate values above.
    warmPaintGateTimeoutMs: 800,
    warmPaintGateHardTimeoutMs: 2_500,
  },
};
