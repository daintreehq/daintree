/** Configuration for auto-closing idle background projects with zero terminals */
export interface IdleBackgroundAutoCloseConfig {
  /** Whether idle background-project auto-close is enabled (default off) */
  enabled: boolean;
  /** Minutes a background project must be idle before it is auto-closed (minimum 15) */
  thresholdMinutes: number;
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
