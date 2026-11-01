import { webContents } from "electron";
import { z } from "zod";
import type { ScheduledRun } from "../../../shared/types/scheduledRuns.js";
import type {
  ScheduledRunInboxItem,
  ScheduledRunsAckInboxPayload,
  ScheduledRunsListByProjectPayload,
  ScheduledRunsListBySchedulePayload,
} from "../../../shared/types/ipc/scheduledRuns.js";
import { AppError } from "../../utils/errorTypes.js";
import { projectStore } from "../../services/ProjectStore.js";
import {
  getScheduledRunRecorder,
  getScheduledRunRecorderForInbox,
} from "../../services/scheduledRuns/index.js";
import { ScheduledRunInbox } from "../../services/scheduledRuns/ScheduledRunInbox.js";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import type { IpcContext } from "../types.js";
import { SCHEDULED_RUNS_METHOD_CHANNELS } from "./scheduledRuns.preload.js";

const ListByProjectSchema = z.object({ projectId: z.string().min(1) });
const ListByScheduleSchema = z.object({ scheduleId: z.string().min(1) });
const AckInboxSchema = z.object({ runIds: z.array(z.string().min(1).max(200)).max(1000) });

let inbox: ScheduledRunInbox | null = null;

function getInbox(): ScheduledRunInbox {
  inbox ??= new ScheduledRunInbox({
    recorder: getScheduledRunRecorderForInbox,
    getSchedule: (projectId, scheduleId) => projectStore.schedules.get(projectId, scheduleId),
    isLive: (id) => {
      const contents = webContents.fromId(id);
      return contents !== undefined && !contents.isDestroyed();
    },
  });
  return inbox;
}

// The inbox is this machine's: another machine's Shell driving it has its own.
function requireLocalView(ctx: IpcContext): void {
  if (ctx.endpoint?.kind === "remote-view") {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "scheduledRuns: the inbox is for this machine's own windows",
    });
  }
}

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
    // Runs that settled with no window open (#15983): a view takes them as it
    // loads, puts them in its notification inbox, then says so.
    takeInbox: op(
      SCHEDULED_RUNS_METHOD_CHANNELS.takeInbox,
      async (ctx: IpcContext): Promise<ScheduledRunInboxItem[]> => {
        requireLocalView(ctx);
        return getInbox().take(ctx.webContentsId);
      },
      { withContext: true }
    ),
    ackInbox: opValidated(
      SCHEDULED_RUNS_METHOD_CHANNELS.ackInbox,
      AckInboxSchema,
      async (ctx: IpcContext, payload: ScheduledRunsAckInboxPayload): Promise<void> => {
        requireLocalView(ctx);
        await getInbox().ack(payload.runIds);
      },
      { withContext: true }
    ),
  },
});

export function _resetScheduledRunInboxForTest(): void {
  inbox = null;
}

export function registerScheduledRunsHandlers(): () => void {
  return scheduledRunsNamespace.register();
}
