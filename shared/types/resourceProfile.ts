export type ResourceProfile = "performance" | "balanced" | "efficiency";

export interface ResourceProfileConfig {
  /** Workspace-host active worktree polling interval (ms) */
  pollIntervalActive: number;
  /** Workspace-host background worktree polling interval (ms) */
  pollIntervalBackground: number;
  /** ProcessTreeCache polling interval (ms) */
  processTreePollInterval: number;
  /** ProjectStatsService polling interval (ms) */
  projectStatsPollInterval: number;
  /** Max WebGL contexts in the renderer */
  maxWebGLContexts: number;
  /**
   * Passive-mode gate: once this many agent terminals hold or are queued for a
   * WebGL context, new acquisitions are suppressed (DOM renderer) to stop
   * release/reacquire churn under large visible fleets.
   */
  passiveWebGLThreshold: number;
  /** FetchScheduler focused (isCurrent) fetch interval (ms) */
  fetchIntervalActiveMs: number;
  /** FetchScheduler background (non-current) fetch interval (ms) */
  fetchIntervalBackgroundMs: number;
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
}

export interface ResourceProfilePayload {
  profile: ResourceProfile;
  config: ResourceProfileConfig;
}

/**
 * Profile configurations.
 * "balanced" values MUST match today's hardcoded defaults exactly:
 * - pollIntervalActive: 2000 (WorkspaceService DEFAULT_ACTIVE_WORKTREE_INTERVAL_MS)
 * - pollIntervalBackground: 10000 (WorkspaceService DEFAULT_BACKGROUND_WORKTREE_INTERVAL_MS)
 * - processTreePollInterval: 2500 (ProcessTreeCache constructor default)
 * - projectStatsPollInterval: 5000 (ProjectStatsService DEFAULT_POLL_INTERVAL_MS)
 * - maxWebGLContexts: 16 (TerminalWebGLConfig initial value)
 * - passiveWebGLThreshold: 12 (TerminalWebGLConfig initial value)
 * - memoryPressureInactiveMs: 1800000 (HibernationService MEMORY_PRESSURE_INACTIVE_MS = 30min)
 */
export const RESOURCE_PROFILE_CONFIGS: Record<ResourceProfile, ResourceProfileConfig> = {
  performance: {
    pollIntervalActive: 1500,
    pollIntervalBackground: 5000,
    processTreePollInterval: 2000,
    projectStatsPollInterval: 5000,
    // Performance mode disables the passive gate (threshold == max) so all
    // slots fill before DOM fallback kicks in. Only reached under low-pressure
    // conditions, so coexisting WebGL consumers have ample budget.
    maxWebGLContexts: 24,
    passiveWebGLThreshold: 24,
    memoryPressureInactiveMs: 60 * 60 * 1000, // 60 min
    lowMemoryFreeThresholdMb: null,
    fetchIntervalActiveMs: 20_000,
    fetchIntervalBackgroundMs: 3 * 60_000,
    paintGateTimeoutMs: 1_500,
    paintGateHardTimeoutMs: 4_000,
  },
  balanced: {
    pollIntervalActive: 2000,
    pollIntervalBackground: 10000,
    processTreePollInterval: 2500,
    projectStatsPollInterval: 5000,
    maxWebGLContexts: 16,
    passiveWebGLThreshold: 12,
    memoryPressureInactiveMs: 30 * 60 * 1000, // 30 min
    lowMemoryFreeThresholdMb: 768,
    fetchIntervalActiveMs: 30_000,
    fetchIntervalBackgroundMs: 5 * 60_000,
    // Balanced cold-start paint-gate values must match
    // `DEFAULT_PAINT_GATE_TIMEOUT_MS` / `DEFAULT_PAINT_GATE_HARD_TIMEOUT_MS` in
    // `electron/window/ProjectViewManager.ts` — those constants are the
    // fallback used until the profile push lands. Keep them in lockstep.
    paintGateTimeoutMs: 1_500,
    paintGateHardTimeoutMs: 4_000,
  },
  efficiency: {
    pollIntervalActive: 4000,
    pollIntervalBackground: 20000,
    processTreePollInterval: 5000,
    projectStatsPollInterval: 25000,
    maxWebGLContexts: 8,
    passiveWebGLThreshold: 8,
    memoryPressureInactiveMs: 15 * 60 * 1000, // 15 min
    lowMemoryFreeThresholdMb: 1024,
    fetchIntervalActiveMs: 45_000,
    fetchIntervalBackgroundMs: 10 * 60_000,
    // Cold starts under memory/thermal/battery pressure routinely run slower
    // than the perf/balanced 1.5s soft bound — keeping efficiency at a 2x
    // headroom preserves the anti-flash hand-off without false-timeout
    // warning spam on degraded hardware.
    paintGateTimeoutMs: 2_500,
    paintGateHardTimeoutMs: 6_000,
  },
};
