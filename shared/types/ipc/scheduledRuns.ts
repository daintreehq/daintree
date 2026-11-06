import type { ScheduledRun } from "../scheduledRuns.js";

/** `window.electron.scheduledRuns.listByProject` (#15976). */
export interface ScheduledRunsListByProjectPayload {
  projectId: string;
}

/** `window.electron.scheduledRuns.listBySchedule` (#15976). */
export interface ScheduledRunsListBySchedulePayload {
  scheduleId: string;
}

/**
 * `scheduled-runs:changed`: the run history of these schedules changed, so a
 * view of the project reads it again. Sent only to views of `projectId`.
 */
export interface ScheduledRunsChangedPayload {
  projectId: string;
  scheduleIds: string[];
}

/**
 * A run that settled while no Daintree window was open, waiting for the
 * notification inbox (#15983), from `window.electron.scheduledRuns.takeInbox`.
 */
export interface ScheduledRunInboxItem {
  run: ScheduledRun;
  /** The run's schedule as it reads now, or null once it's gone. */
  schedule: { name: string; timeZone: string } | null;
}

/** What `window.electron.scheduledRuns.takeInbox` hands a view. */
export interface ScheduledRunInboxTake {
  items: ScheduledRunInboxItem[];
  /**
   * When another live view holds runs still waiting, how long until its hold
   * lapses and asking again may get them; null when none is held elsewhere.
   */
  retryInMs: number | null;
}

/** `window.electron.scheduledRuns.ackInbox`: these runs are in the inbox now. */
export interface ScheduledRunsAckInboxPayload {
  runIds: string[];
}
