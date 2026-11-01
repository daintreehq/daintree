import type {
  Schedule,
  ScheduleCadence,
  ScheduleLaunch,
  SchedulePolicies,
  ScheduledRunSkipReason,
} from "../scheduledRuns.js";
import type { ScheduleIssue } from "../../utils/scheduleValidation.js";
import type { ScheduledRunRef } from "../scheduledRunRef.js";

/** The sender project's schedules (#15975), as this machine stores them. */
export interface SchedulesSnapshot {
  projectId: string;
  /** In the order they were created. */
  schedules: Schedule[];
  /**
   * Rises with every change main commits. A view keeps the newest snapshot it
   * has seen, so a reply and a push that cross can't put an older list back.
   */
  revision: number;
}

/** What a new schedule is made from. Main mints its id and times; the rest takes #15974's defaults. */
export interface ScheduleCreateInput {
  name: string;
  launch: {
    agentId: string;
    prompt: string;
    presetId?: string | null;
    worktreeId?: string | null;
  };
  cron?: string;
  timeZone?: string;
  enabled?: boolean;
  policies?: Partial<SchedulePolicies>;
}

/**
 * An edit. Each part given replaces that whole part of the schedule; a part
 * left out is kept. Enabling and disabling go through `setEnabled`.
 */
export interface ScheduleUpdatePatch {
  name?: string;
  cadence?: ScheduleCadence;
  launch?: ScheduleLaunch;
  policies?: SchedulePolicies;
}

export type ScheduleCreateOutcome =
  | { status: "saved"; schedule: Schedule; snapshot: SchedulesSnapshot }
  /** Nothing saved; each issue names the field it is about. */
  | { status: "invalid"; issues: ScheduleIssue[] };

export type ScheduleUpdateOutcome =
  | { status: "saved"; schedule: Schedule; snapshot: SchedulesSnapshot }
  | { status: "invalid"; issues: ScheduleIssue[] }
  /** The schedule changed after the version the edit was made from. Nothing saved. */
  | { status: "conflict"; schedule: Schedule; snapshot: SchedulesSnapshot }
  /** The schedule has been deleted. */
  | { status: "not-found"; snapshot: SchedulesSnapshot };

export type ScheduleSetEnabledOutcome =
  | { status: "saved"; schedule: Schedule; snapshot: SchedulesSnapshot }
  | { status: "not-found"; snapshot: SchedulesSnapshot };

/** Also the answer when the schedule was already gone. */
export interface ScheduleRemoveOutcome {
  status: "removed";
  snapshot: SchedulesSnapshot;
}

/**
 * What the user agreed to when Run now found the schedule's earlier runs still
 * open (#15980): the overlap policy the confirmation showed and the runs it
 * named. Run now goes ahead only while both still hold; a run that opened
 * since, or a changed policy, asks again.
 */
export interface ScheduleRunNowOverlapConfirmation {
  policy: "skip" | "replace";
  openRunIds: string[];
}

export interface ScheduleRunNowOptions {
  overlap?: ScheduleRunNowOverlapConfirmation;
}

/**
 * Run now (#15978). `started`: the run is registered in the history and its
 * terminal is starting; what happens next arrives as the run's own facts.
 */
export type ScheduleRunNowOutcome =
  | { status: "started"; runId: string; terminalId: string }
  /** Recorded as skipped, with why: its precondition didn't pass. */
  | { status: "skipped"; runId: string; reason: ScheduledRunSkipReason }
  /**
   * Nothing ran and nothing was recorded: earlier runs are still open, and
   * under this policy Run now needs the user's word first. Asking again with
   * {@link ScheduleRunNowOptions.overlap} runs alongside them (`skip`) or
   * replaces them (`replace`).
   */
  | {
      status: "confirm-overlap";
      policy: "skip" | "replace";
      openRunIds: string[];
      /** The schedule's name, for the question. */
      scheduleName: string;
    }
  /**
   * Nothing started. `runId` names the failed run the history recorded with
   * this reason, or is null when the history couldn't record one.
   */
  | { status: "failed"; runId: string | null; message: string }
  /** The schedule has been deleted. */
  | { status: "not-found" };

/**
 * Main asks the view showing a project to launch a scheduled run (#15978). The
 * view dispatches `agent.launch` with `args` and stamps `scheduledRun` as the
 * dispatch's provenance, which no argument can set, then answers on
 * `schedules:launch-response` with {@link ScheduledLaunchViewResponse}.
 */
export interface ScheduledLaunchViewRequest {
  requestId: string;
  args: Record<string, unknown>;
  scheduledRun: ScheduledRunRef;
}

export interface ScheduledLaunchViewResponse {
  requestId: string;
  result: import("../actions.js").ActionDispatchResult;
}

/**
 * Main asks the views of a project to apply a run's done policy to its pane
 * (#15982): move it to the background, or remove it once Main has closed its
 * terminal and captured its session. A view acts only on a pane of that run.
 */
export interface ScheduledRunFinishRequest {
  runId: string;
  terminalId: string;
  action: "background" | "remove";
}

/**
 * A run's terminal main closed to replace it under the overlap policy
 * (#15980): its process is gone and its session captured. A view showing the
 * project takes the run's pane out, as `terminalId` holding that run.
 */
export interface ScheduledRunClosedPush {
  runId: string;
  terminalId: string;
}
