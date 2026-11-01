import type {
  ScheduleCreateInput,
  ScheduleCreateOutcome,
  ScheduleOsJobStatus,
  ScheduleRemoveOutcome,
  ScheduleRunNowOptions,
  ScheduleRunNowOutcome,
  ScheduleSetEnabledOutcome,
  SchedulesSnapshot,
  ScheduleUpdateOutcome,
  ScheduleUpdatePatch,
} from "@shared/types/ipc/schedules";
import type { ScheduledRunsChangedPayload } from "@shared/types/ipc/scheduledRuns";
import type { ScheduledRun } from "@shared/types/scheduledRuns";

/** The current project's schedules (#15975). Every call works on this view's own project. */
export const schedulesClient = {
  list: (): Promise<SchedulesSnapshot | null> => window.electron.schedules.list(),
  create: (input: ScheduleCreateInput): Promise<ScheduleCreateOutcome> =>
    window.electron.schedules.create(input),
  update: (
    id: string,
    expectedUpdatedAt: number,
    patch: ScheduleUpdatePatch
  ): Promise<ScheduleUpdateOutcome> =>
    window.electron.schedules.update(id, expectedUpdatedAt, patch),
  setEnabled: (id: string, enabled: boolean): Promise<ScheduleSetEnabledOutcome> =>
    window.electron.schedules.setEnabled(id, enabled),
  remove: (id: string): Promise<ScheduleRemoveOutcome> => window.electron.schedules.remove(id),
  /**
   * Launches the schedule's agent now as a tracked run (#15978), under its
   * overlap policy and precondition (#15980). `options.overlap` answers a
   * `confirm-overlap` outcome.
   */
  runNow: (id: string, options?: ScheduleRunNowOptions): Promise<ScheduleRunNowOutcome> =>
    options ? window.electron.schedules.runNow(id, options) : window.electron.schedules.runNow(id),
  /** The OS job that starts Daintree for schedules when it isn't running (#15990). */
  osJobStatus: (): Promise<ScheduleOsJobStatus> => window.electron.schedules.osJobStatus(),
  /** Rewrites and reloads that job from the saved schedules. */
  repairOsJob: (): Promise<ScheduleOsJobStatus> => window.electron.schedules.repairOsJob(),
  onChanged: (callback: (snapshot: SchedulesSnapshot) => void): (() => void) =>
    window.electron.schedules.onChanged(callback),
  /** The project's recorded runs, newest first (#15976). */
  listRuns: (projectId: string): Promise<ScheduledRun[]> =>
    window.electron.scheduledRuns.listByProject({ projectId }),
  /** One schedule's recorded runs, newest first (#15976). */
  listScheduleRuns: (scheduleId: string): Promise<ScheduledRun[]> =>
    window.electron.scheduledRuns.listBySchedule({ scheduleId }),
  onRunsChanged: (callback: (payload: ScheduledRunsChangedPayload) => void): (() => void) =>
    window.electron.events.on("scheduled-runs:changed", callback),
};
