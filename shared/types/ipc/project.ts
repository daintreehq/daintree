import type { Project } from "../project.js";

/** Payload for project:on-switch event with cancellation token */
export interface ProjectSwitchPayload {
  /** The project being switched to */
  project: Project;
  /** Unique identifier for this switch operation */
  switchId: string;
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

/** Status of a per-project MCP server process */
export type ProjectMcpServerStatus = "starting" | "running" | "stopped" | "error";

/** Runtime state of a per-project MCP server process */
export interface ProjectMcpServerRunState {
  name: string;
  status: ProjectMcpServerStatus;
  pid?: number;
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
