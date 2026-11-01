import type {
  Schedule,
  ScheduleCadence,
  ScheduleLaunch,
  SchedulePolicies,
} from "../scheduledRuns.js";
import type { ScheduleIssue } from "../../utils/scheduleValidation.js";

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
