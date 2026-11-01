import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import {
  getWebContentsForProject,
  isCachedViewWebContents,
} from "../../window/webContentsRegistry.js";
import { thawThenSend } from "../../utils/thawThenSend.js";
import { projectStore } from "../ProjectStore.js";
import type {
  ScheduleRunNowOutcome,
  ScheduleRunNowOverlapConfirmation,
  ScheduledRunClosedPush,
} from "../../../shared/types/ipc/schedules.js";
import type { ScheduledRun, ScheduledRunOrigin } from "../../../shared/types/scheduledRuns.js";
import { getScheduledRunRecorder } from "./index.js";
import { armScheduledRunDonePolicy } from "./scheduledRunDonePolicyLive.js";
import {
  launchScheduledRun,
  type ScheduledRunLaunchOutcome,
  type ScheduledRunLauncherDeps,
} from "./ScheduledRunLauncher.js";
import { runSchedulePrecondition } from "./scheduledRunPrecondition.js";
import { requestScheduledLaunchInView } from "./scheduledRunViewBridge.js";

/** A run the user asked for: no occurrence of the cadence stands behind it. */
export const RUN_NOW_ORIGIN: ScheduledRunOrigin = {
  trigger: "run-now",
  dueAt: null,
  occurrenceKey: null,
  coalesced: null,
};

/**
 * The view to launch in: the one that asked when it shows the project, else
 * the one on screen, else a cached one, which the bridge thaws without
 * showing it.
 */
function findProjectView(
  projectId: string,
  preferredWebContentsId?: number
): Electron.WebContents | null {
  const views = getWebContentsForProject(projectId);
  if (preferredWebContentsId !== undefined) {
    const preferred = views.find((view) => view.id === preferredWebContentsId);
    if (preferred) return preferred;
  }
  return views.find((view) => !isCachedViewWebContents(view.id)) ?? views[0] ?? null;
}

/** A project nothing showed was `closed`; with a run in it, it's running in the background. */
function markProjectRunning(projectId: string): void {
  if (projectStore.getProjectById(projectId)?.status !== "closed") return;
  const updated = projectStore.updateProjectStatus(projectId, "background", {
    autoParkedAt: null,
  });
  broadcastToRenderer(CHANNELS.PROJECT_UPDATED, updated);
}

/**
 * Closes a run's terminal through the same handler a view's graceful kill
 * reaches: the agent is asked to quit, its session captured and journaled
 * for resuming, then the PTY killed.
 */
async function closeRunTerminal(run: ScheduledRun): Promise<string | null> {
  if (run.terminalId === null) return null;
  const { invokeHostChannel } = await import("../viewless/viewlessInvoke.js");
  return invokeHostChannel<string | null>(run.projectId, CHANNELS.TERMINAL_GRACEFUL_KILL, [
    run.terminalId,
  ]);
}

/**
 * A view showing the project owns its layout, so each one drops the pane and
 * its persistence saves that; with none, the saved layout forgets it, or the
 * next window to open the project would bring the closed run back.
 */
async function removeRunPane(run: ScheduledRun): Promise<void> {
  const { terminalId } = run;
  if (terminalId === null) return;
  const views = getWebContentsForProject(run.projectId);
  if (views.length === 0) {
    const { forgetViewlessTerminal } = await import("../viewless/projectStateAuthoring.js");
    await forgetViewlessTerminal(projectStore, run.projectId, terminalId);
    return;
  }
  const push: ScheduledRunClosedPush = { runId: run.id, terminalId };
  for (const view of views) {
    // A cached view may be frozen; it drops the pane when thawed.
    thawThenSend(
      view,
      () => !view.isDestroyed(),
      () => {
        try {
          view.send(CHANNELS.SCHEDULES_RUN_CLOSED, push);
        } catch {
          // A view closing mid-send has no pane left to drop.
        }
      }
    );
  }
}

async function liveDeps(): Promise<ScheduledRunLauncherDeps<Electron.WebContents>> {
  const [
    { isProjectSleepInFlight },
    { runScheduledAgentLaunchLive },
    { buildProjectCommandEnv, readProjectCommandEnvLayers },
  ] = await Promise.all([
    import("../projectSleep.js"),
    import("../viewless/index.js"),
    import("../ProjectCommandService.js"),
  ]);
  return {
    getRecorder: getScheduledRunRecorder,
    getSchedule: (projectId, scheduleId) => projectStore.schedules.get(projectId, scheduleId),
    getProject: (projectId) => projectStore.getProjectById(projectId),
    folderExists: (path) =>
      fs.access(path).then(
        () => true,
        () => false
      ),
    isProjectSleeping: isProjectSleepInFlight,
    markProjectRunning,
    findView: findProjectView,
    launchInView: (view, request) => requestScheduledLaunchInView(view, request),
    launchWithoutView: (project, request) => runScheduledAgentLaunchLive(project, request),
    runPrecondition: async ({ projectId, command, cwd, signal }) => {
      // The variables the user set for terminals, as a project command gets them.
      const layers = await readProjectCommandEnvLayers(projectId).catch((error: unknown) => {
        console.warn("[ScheduledRuns] Couldn't read environment variables for a precondition:", error);
        return null;
      });
      return runSchedulePrecondition({
        command,
        cwd,
        env: () => buildProjectCommandEnv(layers),
        signal,
      });
    },
    closeRunTerminal,
    removeRunPane,
    newId: randomUUID,
    onLaunched: armScheduledRunDonePolicy,
  };
}

/** Launches a schedule's agent as a tracked run; see {@link launchScheduledRun}. */
export async function launchScheduledRunLive(input: {
  projectId: string;
  scheduleId: string;
  origin: ScheduledRunOrigin;
  preferredWebContentsId?: number;
}): Promise<ScheduledRunLaunchOutcome> {
  return launchScheduledRun(input, await liveDeps());
}

/** Run now: the schedule's agent, now, under its overlap policy and precondition. */
export async function runScheduleNowLive(input: {
  projectId: string;
  scheduleId: string;
  preferredWebContentsId?: number;
  overlapConfirmed?: ScheduleRunNowOverlapConfirmation;
}): Promise<ScheduleRunNowOutcome> {
  const outcome = await launchScheduledRun({ ...input, origin: RUN_NOW_ORIGIN }, await liveDeps());
  // Run now names no occurrence, so the history never already holds one.
  if (outcome.status === "already-recorded") {
    return { status: "failed", runId: outcome.runId, message: "The run was already recorded." };
  }
  return outcome;
}
