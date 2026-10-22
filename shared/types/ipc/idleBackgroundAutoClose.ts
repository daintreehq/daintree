/** The thresholds the idle-shell sleep offers, in minutes (1h, 2h, 4h, 8h). */
export const IDLE_SHELL_THRESHOLD_MINUTES = [60, 120, 240, 480] as const;

export type IdleShellThresholdMinutes = (typeof IDLE_SHELL_THRESHOLD_MINUTES)[number];

export function isIdleShellThresholdMinutes(value: unknown): value is IdleShellThresholdMinutes {
  return (IDLE_SHELL_THRESHOLD_MINUTES as readonly unknown[]).includes(value);
}

/** Configuration for putting idle background projects to sleep automatically */
export interface IdleBackgroundAutoCloseConfig {
  /** Whether idle background projects are slept automatically (default off) */
  enabled: boolean;
  /** Minutes a background project with no terminals must be idle before it sleeps (minimum 15) */
  thresholdMinutes: number;
  /**
   * Whether projects whose only terminals are plain shells with nothing running
   * are slept too (default off). Projects with agents are never included.
   */
  includeIdleShells: boolean;
  /** Minutes such a project must be off screen and quiet before it sleeps */
  idleShellThresholdMinutes: IdleShellThresholdMinutes;
}

/** A single project entry inside an auto-close broadcast payload */
export interface IdleBackgroundClosedProjectEntry {
  projectId: string;
  projectName: string;
}

/** Broadcast payload emitted after one or more idle background projects are auto-closed */
export interface IdleBackgroundClosedPayload {
  projects: IdleBackgroundClosedProjectEntry[];
  timestamp: number;
}
