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
   * Whether projects with terminals are slept too (default off): every one a
   * plain shell with nothing running, or an agent at its prompt with nothing
   * running beside it that will resume its conversation.
   */
  includeIdleShells: boolean;
  /** Minutes such a project must be off screen and quiet before it sleeps */
  idleShellThresholdMinutes: IdleShellThresholdMinutes;
}

/** What started a sweep: the regular idle check, or the memory-pressure ladder */
export type IdleBackgroundSweepTrigger = "idle" | "memory-pressure";

/** A single project entry inside an auto-close broadcast payload */
export interface IdleBackgroundClosedProjectEntry {
  projectId: string;
  projectName: string;
  /**
   * Resident memory of the project's terminal process trees, as the process
   * census last read it before the sleep. Summed per process, so shared pages
   * count more than once: an estimate, never a measured reclaim. Absent for a
   * project that had no terminals.
   */
  estimatedMemoryKb?: number;
}

/** Broadcast payload emitted after one or more idle background projects are auto-closed */
export interface IdleBackgroundClosedPayload {
  projects: IdleBackgroundClosedProjectEntry[];
  timestamp: number;
  /** Absent reads as `"idle"`. */
  trigger?: IdleBackgroundSweepTrigger;
}
