import { z } from "zod";
import type { ScheduledRun } from "../../../shared/types/scheduledRuns.js";
import type {
  ScheduledRunsListByProjectPayload,
  ScheduledRunsListBySchedulePayload,
} from "../../../shared/types/ipc/scheduledRuns.js";
import { getScheduledRunRecorder } from "../../services/scheduledRuns/index.js";
import { defineIpcNamespace, opValidated } from "../define.js";
import { SCHEDULED_RUNS_METHOD_CHANNELS } from "./scheduledRuns.preload.js";

const ListByProjectSchema = z.object({ projectId: z.string().min(1) });
const ListByScheduleSchema = z.object({ scheduleId: z.string().min(1) });

/**
 * Read side of scheduled-run history (#15976), newest first. Read-only: main
 * registers runs and records the facts on them, so no view can write one.
 */
export const scheduledRunsNamespace = defineIpcNamespace({
  name: "scheduledRuns",
  ops: {
    listByProject: opValidated(
      SCHEDULED_RUNS_METHOD_CHANNELS.listByProject,
      ListByProjectSchema,
      async (payload: ScheduledRunsListByProjectPayload): Promise<ScheduledRun[]> => {
        const recorder = await getScheduledRunRecorder();
        return recorder ? recorder.listByProject(payload.projectId) : [];
      }
    ),
    listBySchedule: opValidated(
      SCHEDULED_RUNS_METHOD_CHANNELS.listBySchedule,
      ListByScheduleSchema,
      async (payload: ScheduledRunsListBySchedulePayload): Promise<ScheduledRun[]> => {
        const recorder = await getScheduledRunRecorder();
        return recorder ? recorder.listBySchedule(payload.scheduleId) : [];
      }
    ),
  },
});

export function registerScheduledRunsHandlers(): () => void {
  return scheduledRunsNamespace.register();
}
