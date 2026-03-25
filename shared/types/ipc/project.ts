import type { Project } from "../project.js";

/** Payload for project:on-switch event with cancellation token */
export interface ProjectSwitchPayload {
  /** The project being switched to */
  project: Project;
  /** Unique identifier for this switch operation */
  switchId: string;
  /** If the workspace host failed to load worktrees (e.g. non-git directory) */
  worktreeLoadError?: string;
}

/** Result from project:close operation */
export interface ProjectCloseResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Total number of processes killed */
  processesKilled: number;
  /** Number of terminals killed */
  terminalsKilled: number;
  /** Error message if operation failed */
  error?: string;
}

/** Project resource statistics */
export interface ProjectStats {
  /** Total number of running processes */
  processCount: number;
  /** Number of terminal processes */
  terminalCount: number;
  /** Estimated memory usage in MB */
  estimatedMemoryMB: number;
  /** Terminal types breakdown */
  terminalTypes: Record<string, number>;
  /** Process IDs of running terminals */
  processIds: number[];
}

/** Per-project entry in bulk stats response, includes agent counts */
export interface BulkProjectStatsEntry extends ProjectStats {
  activeAgentCount: number;
  waitingAgentCount: number;
}

/** Bulk project stats response keyed by project ID */
export type BulkProjectStats = Record<string, BulkProjectStatsEntry>;
