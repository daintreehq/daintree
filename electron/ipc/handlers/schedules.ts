import { z } from "zod";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { isWithheldFromView } from "../utils.js";
import { SCHEDULES_METHOD_CHANNELS } from "./schedules.preload.js";
import { AppError } from "../../utils/errorTypes.js";
import { projectStore } from "../../services/ProjectStore.js";
import { isValidProjectId } from "../../services/projectStorePaths.js";
import { getRegisteredProjectViews } from "../../window/webContentsRegistry.js";
import { isLocalHostId, parseHostScopedKey } from "../../../shared/types/remoteHosts.js";
import {
  SCHEDULE_DONE_POLICIES,
  SCHEDULE_MISSED_RUN_POLICIES,
  SCHEDULE_OVERLAP_POLICIES,
} from "../../../shared/types/scheduledRuns.js";
import type {
  ScheduleCreateInput,
  ScheduleCreateOutcome,
  ScheduleRemoveOutcome,
  ScheduleRunNowOptions,
  ScheduleRunNowOutcome,
  ScheduleSetEnabledOutcome,
  ScheduleUpdateOutcome,
  ScheduleUpdatePatch,
  SchedulesSnapshot,
} from "../../../shared/types/ipc/schedules.js";

/**
 * The SENDER project's schedules (#15975). No op takes a project id: main
 * resolves it from the sender's own view registration, so a view can only ever
 * read or change the schedules of the project it shows, and only a project on
 * this machine has them. Not an action, so not on the MCP surface.
 *
 * The shapes below check types only. What a value means (a blank name, a cron
 * expression that never fires) is the store's to judge, and comes back as an
 * `invalid` outcome naming the field, never as a thrown error: thrown errors
 * are logged, and these replies carry what the user typed.
 */

const ScheduleIdShape = z.string().min(1).max(200);
const UpdatedAtShape = z.number().int().nonnegative();

const RunNowOptionsShape = z
  .strictObject({
    overlap: z
      .strictObject({
        policy: z.enum(["skip", "replace"]),
        openRunIds: z.array(z.string().min(1).max(200)).max(100),
      })
      .optional(),
  })
  .optional();

const PoliciesShape = z.strictObject({
  missedRuns: z.enum(SCHEDULE_MISSED_RUN_POLICIES),
  overlap: z.enum(SCHEDULE_OVERLAP_POLICIES),
  precondition: z.strictObject({ command: z.string() }).nullable(),
  onDone: z.enum(SCHEDULE_DONE_POLICIES),
  runWhenClosed: z.boolean(),
});

const CreateInputShape = z.strictObject({
  name: z.string(),
  launch: z.strictObject({
    agentId: z.string(),
    prompt: z.string(),
    presetId: z.string().nullable().optional(),
    worktreeId: z.string().nullable().optional(),
  }),
  cron: z.string().optional(),
  timeZone: z.string().optional(),
  enabled: z.boolean().optional(),
  policies: PoliciesShape.partial().optional(),
});

const UpdatePatchShape = z.strictObject({
  name: z.string().optional(),
  cadence: z.strictObject({ cron: z.string(), timeZone: z.string() }).optional(),
  launch: z
    .strictObject({
      agentId: z.string(),
      presetId: z.string().nullable(),
      prompt: z.string(),
      worktreeId: z.string().nullable(),
    })
    .optional(),
  policies: PoliciesShape.optional(),
});

function parsed<T>(shape: z.ZodType<T>, value: unknown, what: string): T {
  const result = shape.safeParse(value);
  if (result.success) return result.data;
  throw new AppError({ code: "VALIDATION", message: `schedules: ${what}` });
}

/**
 * The project the sender shows, or null before its view is bound to one: a
 * relaunch restores the last project before its view is registered, so the
 * view asks again rather than taking an empty list.
 */
function senderProjectId(ctx: IpcContext): string | null {
  if (!ctx.projectId) return null;
  const { hostId, projectId } = parseHostScopedKey(ctx.projectId);
  if (ctx.endpoint?.kind === "remote-view" || !isLocalHostId(hostId)) {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "schedules: only a project on this machine has schedules",
    });
  }
  if (!isValidProjectId(projectId)) {
    throw new AppError({ code: "UNSUPPORTED", message: "schedules: only a project has schedules" });
  }
  if (!projectStore.getProjectById(projectId)) {
    throw new AppError({
      code: "NOT_FOUND",
      message: `schedules: project ${projectId} is not registered`,
    });
  }
  return projectId;
}

function requireSenderProjectId(ctx: IpcContext): string {
  const projectId = senderProjectId(ctx);
  if (!projectId)
    throw new AppError({ code: "VALIDATION", message: "schedules: sender has no project" });
  return projectId;
}

async function handleList(ctx: IpcContext): Promise<SchedulesSnapshot | null> {
  const projectId = senderProjectId(ctx);
  return projectId ? projectStore.schedules.list(projectId) : null;
}

async function handleCreate(
  ctx: IpcContext,
  input: ScheduleCreateInput
): Promise<ScheduleCreateOutcome> {
  const projectId = requireSenderProjectId(ctx);
  return projectStore.schedules.create(
    projectId,
    parsed(CreateInputShape, input, "not a new schedule")
  );
}

/**
 * `expectedUpdatedAt` is the `updatedAt` of the version the edit was made
 * from; one changed since, in any window, is a conflict.
 */
async function handleUpdate(
  ctx: IpcContext,
  scheduleId: string,
  expectedUpdatedAt: number,
  patch: ScheduleUpdatePatch
): Promise<ScheduleUpdateOutcome> {
  const projectId = requireSenderProjectId(ctx);
  return projectStore.schedules.update(
    projectId,
    parsed(ScheduleIdShape, scheduleId, "scheduleId must name a schedule"),
    parsed(UpdatedAtShape, expectedUpdatedAt, "expectedUpdatedAt must be the version edited"),
    parsed(UpdatePatchShape, patch, "not a schedule edit")
  );
}

async function handleSetEnabled(
  ctx: IpcContext,
  scheduleId: string,
  enabled: boolean
): Promise<ScheduleSetEnabledOutcome> {
  const projectId = requireSenderProjectId(ctx);
  return projectStore.schedules.setEnabled(
    projectId,
    parsed(ScheduleIdShape, scheduleId, "scheduleId must name a schedule"),
    parsed(z.boolean(), enabled, "enabled must be true or false")
  );
}

/**
 * Launches the schedule's agent now, as a tracked run (#15978), enabled or
 * not: asking is the opt-in. In the asking view when it shows the project.
 * Its overlap policy and precondition apply (#15980); with earlier runs still
 * open it asks first, and `options.overlap` is the user's answer.
 */
async function handleRunNow(
  ctx: IpcContext,
  scheduleId: string,
  options?: ScheduleRunNowOptions
): Promise<ScheduleRunNowOutcome> {
  const projectId = requireSenderProjectId(ctx);
  const validScheduleId = parsed(ScheduleIdShape, scheduleId, "scheduleId must name a schedule");
  const overlap = parsed(RunNowOptionsShape, options, "options must be a Run now answer")?.overlap;
  const { runScheduleNowLive } =
    await import("../../services/scheduledRuns/scheduledRunLaunchLive.js");
  return runScheduleNowLive({
    projectId,
    scheduleId: validScheduleId,
    preferredWebContentsId: ctx.webContentsId,
    ...(overlap ? { overlapConfirmed: overlap } : {}),
  });
}

async function handleRemove(ctx: IpcContext, scheduleId: string): Promise<ScheduleRemoveOutcome> {
  const projectId = requireSenderProjectId(ctx);
  return projectStore.schedules.remove(
    projectId,
    parsed(ScheduleIdShape, scheduleId, "scheduleId must name a schedule")
  );
}

/**
 * Every local view of the project hears of a change, cached views and the
 * writer included. Not `broadcastToProjectRenderers`: with no project view
 * registered it falls back to every window, which would hand one project's
 * schedules to whatever window is open.
 */
export function pushSchedulesToViews(snapshot: SchedulesSnapshot): void {
  for (const view of getRegisteredProjectViews()) {
    const { hostId, projectId } = parseHostScopedKey(view.projectId);
    if (!isLocalHostId(hostId) || projectId !== snapshot.projectId) continue;
    const { webContents } = view;
    if (isWithheldFromView(webContents.id, CHANNELS.SCHEDULES_CHANGED, [snapshot])) continue;
    try {
      webContents.send(CHANNELS.SCHEDULES_CHANGED, snapshot);
    } catch {
      // A view closing mid-send misses nothing it could still show.
    }
  }
}

export const schedulesNamespace = defineIpcNamespace({
  name: "schedules",
  ops: {
    list: op(SCHEDULES_METHOD_CHANNELS.list, handleList, { withContext: true }),
    create: op(SCHEDULES_METHOD_CHANNELS.create, handleCreate, { withContext: true }),
    update: op(SCHEDULES_METHOD_CHANNELS.update, handleUpdate, { withContext: true }),
    setEnabled: op(SCHEDULES_METHOD_CHANNELS.setEnabled, handleSetEnabled, { withContext: true }),
    remove: op(SCHEDULES_METHOD_CHANNELS.remove, handleRemove, { withContext: true }),
    runNow: op(SCHEDULES_METHOD_CHANNELS.runNow, handleRunNow, { withContext: true }),
  },
});

export function registerSchedulesHandlers(): () => void {
  const dispose = schedulesNamespace.register();
  const unsubscribe = projectStore.schedules.subscribe(pushSchedulesToViews);
  return () => {
    unsubscribe();
    dispose();
  };
}
