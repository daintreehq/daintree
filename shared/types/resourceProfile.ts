export type ResourceProfile = "performance" | "balanced" | "efficiency";

export interface ResourceProfileConfig {
  /** Workspace-host active worktree polling interval (ms) */
  pollIntervalActive: number;
  /** Workspace-host background worktree polling interval (ms) */
  pollIntervalBackground: number;
  /** ProcessTreeCache polling interval (ms) */
  processTreePollInterval: number;
  /** Max WebGL contexts in the renderer */
  maxWebGLContexts: number;
  /** HibernationService memory-pressure inactivity threshold (ms) */
  memoryPressureInactiveMs: number;
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
 * - maxWebGLContexts: 12 (TerminalWebGLManager MAX_CONTEXTS)
 * - memoryPressureInactiveMs: 1800000 (HibernationService MEMORY_PRESSURE_INACTIVE_MS = 30min)
 */
export const RESOURCE_PROFILE_CONFIGS: Record<ResourceProfile, ResourceProfileConfig> = {
  performance: {
    pollIntervalActive: 1500,
    pollIntervalBackground: 5000,
    processTreePollInterval: 2000,
    maxWebGLContexts: 16,
    memoryPressureInactiveMs: 60 * 60 * 1000, // 60 min
  },
  balanced: {
    pollIntervalActive: 2000,
    pollIntervalBackground: 10000,
    processTreePollInterval: 2500,
    maxWebGLContexts: 12,
    memoryPressureInactiveMs: 30 * 60 * 1000, // 30 min
  },
  efficiency: {
    pollIntervalActive: 4000,
    pollIntervalBackground: 20000,
    processTreePollInterval: 5000,
    maxWebGLContexts: 6,
    memoryPressureInactiveMs: 15 * 60 * 1000, // 15 min
  },
};
