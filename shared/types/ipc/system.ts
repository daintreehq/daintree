import type { AgentId } from "../domain.js";

/** Open external URL payload */
export interface SystemOpenExternalPayload {
  url: string;
}

/** Payload for opening a path */
export interface SystemOpenPathPayload {
  path: string;
}

/** System wake event payload */
export interface SystemWakePayload {
  /** Duration of sleep in milliseconds */
  sleepDuration: number;
  /** Timestamp when the system woke */
  timestamp: number;
}

/** CLI availability status for AI agents */
export type CliAvailability = Record<AgentId, boolean>;

/** Version information for an agent */
export interface AgentVersionInfo {
  /** Agent ID */
  agentId: AgentId;
  /** Current installed version (null if not installed) */
  installedVersion: string | null;
  /** Latest available version (null if unable to check) */
  latestVersion: string | null;
  /** Whether an update is available */
  updateAvailable: boolean;
  /** Last check timestamp */
  lastChecked: number | null;
  /** Error message if version check failed */
  error?: string;
}

/** Agent update settings */
export interface AgentUpdateSettings {
  /** Enable automatic update checks */
  autoCheck: boolean;
  /** Check frequency in hours (default: 24) */
  checkFrequencyHours: number;
  /** Last automatic check timestamp */
  lastAutoCheck: number | null;
}

/** Payload for starting an agent update */
export interface StartAgentUpdatePayload {
  agentId: AgentId;
  /** Preferred update method (e.g., "npm", "brew") */
  method?: string;
}

/** Result of starting an agent update */
export interface StartAgentUpdateResult {
  /** Terminal ID where update is running */
  terminalId: string;
  /** Update command being executed */
  command: string;
}
