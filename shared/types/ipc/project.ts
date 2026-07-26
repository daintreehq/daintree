import type { Project, TerminalSnapshot } from "../project.js";
import type { TabGroup } from "../panel.js";
import type { IdArrayDelta } from "../../utils/layoutMerge.js";
import type { HydrateResult } from "./app.js";

/**
 * Outgoing state passed alongside project switch/reopen IPC calls.
 * The main process applies this to the outgoing project's persisted state
 * before `saveOutgoingProjectWorktreeState` runs, eliminating the race
 * between the renderer's saves and the switch's read-modify-write.
 */
export interface ProjectSwitchOutgoingState {
  terminals?: TerminalSnapshot[];
  terminalSizes?: Record<string, { cols: number; rows: number }>;
  draftInputs?: Record<string, string>;
  tabGroups?: TabGroup[];
  activeWorktreeId?: string;
  /**
   * What this window changed in `terminals`/`tabGroups` relative to its
   * last-persisted baseline. When present, Main merges the arrays by id instead
   * of full-replacing, so switching away from a project open in another window
   * doesn't clobber that window's concurrent layout changes (#11350). Absent =
   * legacy full replace.
   */
  terminalDelta?: IdArrayDelta;
  tabGroupDelta?: IdArrayDelta;
  /**
   * What this window changed in `draftInputs` relative to its last-persisted
   * baseline (`changedIds`/`removedIds` are terminal ids). When present, Main
   * merges the draft record by key instead of full-replacing, so switching away
   * doesn't clobber a sibling window's drafts (#11352). Absent = legacy full
   * replace.
   */
  draftDelta?: IdArrayDelta;
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

/**
 * Targeted `project:worktree-load-status` event. Sent to a single activated
 * project view (production view-swap path) or broadcast on the legacy switch
 * path. `worktreeLoadError` is the formatted failure string, or null when the
 * load succeeded (so a stale banner on a reactivated cached view clears). See
 * #8400.
 */
export interface ProjectWorktreeLoadStatusPayload {
  /** The project whose worktree load this status describes. */
  projectId: string;
  /** Formatted load failure, or null when the load succeeded. */
  worktreeLoadError: string | null;
}

/** Result from project:close operation. Failures throw `AppError`. */
export interface ProjectCloseResult {
  /** Total number of processes killed */
  processesKilled: number;
  /** Number of terminals killed */
  terminalsKilled: number;
}

/**
 * Result from the project:free-memory operation. Reclaims a background
 * project's resident memory (renderer + PTYs + workspace host) while keeping
 * the project in the list as `closed` and preserving its layout for a
 * non-destructive reopen. Failures throw `AppError`.
 */
export interface ProjectFreeMemoryResult {
  /** Number of terminals gracefully killed (sessions preserved for restore). */
  terminalsKilled: number;
  /** True when a cached renderer WebContentsView was torn down. */
  rendererEvicted: boolean;
  /** True when the project's workspace-host process was evicted. */
  workspaceEvicted: boolean;
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
  /**
   * Waiting agents blocked on an error — a subset of
   * {@link BulkProjectStatsEntry.waitingAgentCount}. Carried so a renderer that
   * has never received a pushed status update seeds from the same reading the
   * push would have given it.
   */
  blockedAgentCount: number;
  /** Earliest transition into `waiting`, absent when nothing is waiting. */
  oldestWaitingSince?: number;
  /**
   * Measured resident memory (MB) of this project's terminal process trees —
   * each shell plus every descendant (dev servers, agents, language servers),
   * deduplicated by PID. Undefined when the OS process table couldn't be read;
   * consumers fall back to {@link ProjectStats.estimatedMemoryMB}. Sums RSS, so
   * it counts shared pages — a pressure heuristic, not unique footprint.
   */
  terminalMemoryMB?: number;
  /** Highest-memory process across this project's terminals (basename only). */
  topProcess?: { name: string; memoryMB: number };
}

/** Bulk project stats response keyed by project ID */
export type BulkProjectStats = Record<string, BulkProjectStatsEntry>;

/** Minimal per-project status entry for push-based updates */
export interface ProjectStatusEntry {
  activeAgentCount: number;
  waitingAgentCount: number;
  processCount: number;
  /**
   * Waiting agents whose `waitingReason` is `"error"` — settled after a blocking
   * failure, where input may not unblock them. A subset of
   * {@link ProjectStatusEntry.waitingAgentCount}, never additional to it: the
   * switcher reports "needs input" for the remainder and "blocked" for these,
   * so double-counting would overstate both.
   */
  blockedAgentCount: number;
  /**
   * Epoch ms of the earliest state change among this project's waiting agents,
   * so the switcher can age a wait ("oldest 42m") instead of only asserting one
   * exists. Absent when nothing is waiting, or when no waiting terminal carried
   * a `lastStateChange` (a pre-detection boot window).
   */
  oldestWaitingSince?: number;
}

/**
 * The project this window was in before the current one. Main resolves it; the
 * renderer performs the switch through its ordinary path.
 */
export interface ProjectHistoryTarget {
  projectId: string;
}

/** Project status map pushed from main process, keyed by project ID */
export type ProjectStatusMap = Record<string, ProjectStatusEntry>;
