import type { Project, TerminalSnapshot } from "../project.js";
import type { TabGroup } from "../panel.js";
import type { AgentState, WaitingReason } from "../agent.js";
import type { IdArrayDelta, IdArrayDeltaWire } from "../../utils/layoutMerge.js";
import type { HydrateResult } from "./app.js";

/**
 * Live Daintree Assistant presence for one workspace — what the assistant is
 * doing, not a run the user launched (#11806).
 *
 * Carried beside the worker tallies and never inside them. The assistant is a
 * tooling-internal PTY: it is excluded from `activeAgentCount`,
 * `waitingAgentCount` and `completedAgentCount`, netted out of `processCount`,
 * and absent from the fleet run list. Before these fields existed that
 * exclusion also made it invisible cross-project, so a project whose assistant
 * was working read as dormant.
 *
 * Raw facts, deliberately: whether a given state means "present", "running" or
 * "needs someone" is a presentation decision, and it is made in exactly one
 * place on the renderer side (`classifyAssistantActivity`). Shipping the
 * verdict instead would put that judgement in the producer and let the two
 * drift, which is the whole failure mode #10989 came from.
 */
export interface AssistantPresenceEntry {
  /**
   * The assistant terminal's `agentState`. Absent when the workspace has no
   * live assistant PTY. Settled states (`idle`, `completed`, `exited`) are
   * reported as faithfully as live ones — the consumer decides which of them
   * are worth a status line.
   */
  assistantState?: AgentState;
  /**
   * Why the assistant is waiting. Present only when
   * {@link AssistantPresenceEntry.assistantState} is `"waiting"` — a terminal
   * record can keep a stale reason after leaving the state, and a working
   * assistant carrying a leftover `"error"` would read as blocked.
   */
  assistantWaitingReason?: WaitingReason;
  /**
   * Epoch ms of the assistant's transition into the reported state, so a wait
   * can be aged and compared against when the user last had the project on
   * screen. Absent when no transition has been recorded yet (a pre-detection
   * boot window).
   */
  assistantStateSince?: number;
}

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
  terminalDelta?: IdArrayDeltaWire;
  tabGroupDelta?: IdArrayDeltaWire;
  /**
   * What this window changed in `draftInputs` relative to its last-persisted
   * baseline (`changedIds`/`removedIds` are terminal ids). When present, Main
   * merges the draft record by key instead of full-replacing, so switching away
   * doesn't clobber a sibling window's drafts (#11352). Absent = legacy full
   * replace.
   */
  draftDelta?: IdArrayDelta;
}

/**
 * What the incoming project view should focus once it is activated.
 *
 * A one-shot instruction handed to main at switch time and delivered to the
 * new view when its paint gate resolves. It exists because the caller lives in
 * the OUTGOING view's V8 context: by the time the switch completes that context
 * is no longer the active one, so it cannot focus anything itself.
 *
 * `focus-panel` carries the target explicitly rather than re-deriving it, so
 * clicking a specific run lands on that run — "next waiting" would rank the
 * destination again and could pick a different one.
 */
export type ProjectFocusOnActivateIntent =
  { intent: "focus-next-waiting" } | { intent: "focus-panel"; panelId: string };

/** Which surface started a project switch — the first field of its perf trace. */
export type ProjectSwitchEntryPoint =
  "mru-shortcut" | "palette-keyboard" | "palette-mouse" | "toolbar" | "menu" | "api";

/**
 * Correlation handle threaded from the initiating renderer through main to the
 * incoming view, so every `project_switch.*` perf mark of one switch shares an
 * id. Minted where the gesture lands; main mints one itself when a caller has
 * none (menu, MCP, tests).
 */
export interface ProjectSwitchTrace {
  switchId: string;
  entryPoint: ProjectSwitchEntryPoint;
}

/** Payload for project:on-switch event with cancellation token */
export interface ProjectSwitchPayload {
  /** The project being switched to */
  project: Project;
  /** Unique identifier for this switch operation */
  switchId: string;
  /** Where the switch started; absent on the legacy non-PVM path. */
  entryPoint?: ProjectSwitchEntryPoint;
  /** True when the view was reactivated from the LRU cache rather than cold-started. */
  cacheHit?: boolean;
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
 * Result from the project:sleep operation. Shuts one project down the way
 * quitting shuts them all down — session-preserving kill, captured agent
 * session ids written back into the saved panel snapshots, a resume record
 * journaled per agent — then reclaims what it can (renderer + PTYs + workspace
 * host) and leaves the project in the list as `closed` with its layout intact
 * for a non-destructive reopen. Failures throw `AppError`.
 */
export interface ProjectSleepResult {
  /** Number of terminals gracefully killed (sessions preserved for restore). */
  terminalsKilled: number;
  /**
   * How many windows had a CACHED view for this project torn down. A window
   * with the project on screen is not counted: it keeps its view and drops to
   * the no-project state in the renderer instead.
   */
  rendererViewsEvicted: number;
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
export interface BulkProjectStatsEntry extends ProjectStats, AssistantPresenceEntry {
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
  /** Agents settled in `completed` — finished work awaiting review. */
  completedAgentCount: number;
  /**
   * Completed agents the user hasn't seen yet — their completion postdates the
   * project's acknowledgement watermark. Subset of
   * {@link BulkProjectStatsEntry.completedAgentCount}.
   */
  unacknowledgedCompletedAgentCount: number;
  /** Earliest unacknowledged completion, absent when everything was seen. */
  oldestUnacknowledgedCompletionAt?: number;
  /** Latest unacknowledged completion, absent when everything was seen. */
  latestUnacknowledgedCompletionAt?: number;
  /** Latest completion regardless of acknowledgement, absent when none. */
  latestCompletionAt?: number;
  /** Latest transition into `working`, absent when nothing is working. */
  latestWorkingSince?: number;
  /**
   * Agents the user snoozed. Carried for the same reason the blocked count is:
   * a renderer seeded from bulk must reach the same reading the push would have
   * given it, and without this a cold palette would band an all-snoozed project
   * as dormant until agent state next moved.
   */
  snoozedAgentCount: number;
  /** Earliest wake time among snoozed agents, absent when none has one. */
  nextSnoozeWakeAt?: number;
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
export interface ProjectStatusEntry extends AssistantPresenceEntry {
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
  /** Agents settled in `completed` — finished work awaiting review. */
  completedAgentCount: number;
  /**
   * Completed agents the user hasn't seen yet: their transition into
   * `completed` postdates the project's acknowledgement watermark
   * (`Project.lastCompletionSeenAt`). Holds the project in the switcher's
   * "Needs attention" band with no time-based expiry — work finished while the
   * user was away stays surfaced until actually seen. A subset of
   * {@link ProjectStatusEntry.completedAgentCount}.
   */
  unacknowledgedCompletedAgentCount: number;
  /**
   * Earliest unacknowledged completion (epoch ms). Oldest-first ordering in
   * the attention band's review tier — prevents review starvation under a
   * stream of newer completions. Absent when everything was seen.
   */
  oldestUnacknowledgedCompletionAt?: number;
  /** Latest unacknowledged completion (epoch ms), for "just finished" copy. */
  latestUnacknowledgedCompletionAt?: number;
  /**
   * Latest completion regardless of acknowledgement (epoch ms) — drives the
   * muted "Agent finished · 2h ago" line after the work has been seen.
   */
  latestCompletionAt?: number;
  /**
   * Latest transition into `working` (epoch ms). Secondary ordering key for
   * the Running band. Absent when nothing is working or no working terminal
   * carried a `lastStateChange`.
   */
  latestWorkingSince?: number;
  /**
   * Agents the user snoozed, whatever they are doing underneath. NOT a subset
   * of any single count above: a snoozed run still counts toward
   * {@link ProjectStatusEntry.activeAgentCount} and
   * {@link ProjectStatusEntry.completedAgentCount}, but is withheld from
   * `waitingAgentCount`, `blockedAgentCount` and
   * `unacknowledgedCompletedAgentCount` — snooze suppresses attention, not
   * presence.
   *
   * The field the switcher needs to tell "every agent here is snoozed" apart
   * from "nothing is here", which are the same zero on every other count.
   */
  snoozedAgentCount: number;
  /**
   * Earliest wake time among this project's snoozed agents (epoch ms). Absent
   * when nothing is snoozed, and also when every snooze is the unlimited
   * option — that one has no wake time, and reporting a substitute would date
   * a snooze that no clock will ever end.
   */
  nextSnoozeWakeAt?: number;
}

/**
 * The workspace this window was in before the current one — a project or a
 * scratch (#11936). Main resolves it; the renderer performs the switch through
 * its ordinary path, routing on the id's shape the way every other
 * project-or-scratch destination does.
 */
export interface ProjectHistoryTarget {
  workspaceId: string;
}

/**
 * Workspace status map pushed from the main process, keyed by workspace ID —
 * project ids and scratch ids alike (#11518). The two formats are disjoint
 * (64-char hex vs UUID), so one map can carry both without collision.
 */
export type ProjectStatusMap = Record<string, ProjectStatusEntry>;
