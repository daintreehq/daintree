import type { Project, TerminalSnapshot } from "../project.js";
import type { HydrateResult } from "./app.js";

/**
 * Outgoing terminal state passed alongside project switch/reopen IPC calls.
 * The main process applies this to the outgoing project's persisted state
 * before `saveOutgoingProjectWorktreeState` runs, eliminating the race
 * between the renderer's terminal saves and the switch's read-modify-write.
 */
export interface ProjectSwitchOutgoingState {
  terminals?: TerminalSnapshot[];
  terminalSizes?: Record<string, { cols: number; rows: number }>;
}

/** Payload for project:on-switch event with cancellation token */
export interface ProjectSwitchPayload {
  /** The project being switched to */
  project: Project;
  /** Unique identifier for this switch operation */
  switchId: string;
  /** If the workspace host failed to load worktrees (e.g. non-git directory) */
  worktreeLoadError?: string;
  /** Pre-built hydration data to skip the redundant APP_HYDRATE IPC round-trip */
  hydrateResult?: HydrateResult;
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

/** Minimal per-project status entry for push-based updates */
export interface ProjectStatusEntry {
  activeAgentCount: number;
  waitingAgentCount: number;
  processCount: number;
}

/** Project status map pushed from main process, keyed by project ID */
export type ProjectStatusMap = Record<string, ProjectStatusEntry>;
