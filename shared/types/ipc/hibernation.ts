/** Configuration for auto-hibernation feature */
export interface HibernationConfig {
  /** Whether auto-hibernation is enabled */
  enabled: boolean;
  /** Hours of inactivity before a project is hibernated */
  inactiveThresholdHours: number;
}

export interface HibernationProjectHibernatedPayload {
  projectId: string;
  projectName: string;
  reason: "scheduled" | "memory-pressure";
  terminalsKilled: number;
  timestamp: number;
}
