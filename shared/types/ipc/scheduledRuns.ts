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
