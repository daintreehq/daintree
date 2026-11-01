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
 * The incarnation running under a terminal id now, or null when none is. A
 * host that doesn't answer in time throws rather than reading as gone.
 */
async function liveIncarnation(terminalId: string): Promise<number | null> {
  const { getPtyClient } = await import("../../window/serviceRefs.js");
  const pty = getPtyClient();
  if (!pty) return null;
  const info = await pty.getTerminalAsync(terminalId, undefined, { strict: true });
  return info && info.isExited !== true ? info.spawnedAt : null;
}

/**
 * Closes a run's terminal through the same handler a view's graceful kill
 * reaches: the agent is asked to quit, its session captured and journaled
 * for resuming, then the PTY killed. A terminal restarted since the run's
 * incarnation is the user's now, and isn't closed.
 */
async function closeRunTerminal(run: ScheduledRun): Promise<string | null> {
  if (run.terminalId === null) return null;
  const live = await liveIncarnation(run.terminalId);
  if (live !== null && run.terminalSpawnedAt !== null && live !== run.terminalSpawnedAt) {
    throw new Error("The run's terminal was restarted.");
  }
  const { invokeHostChannel } = await import("../viewless/viewlessInvoke.js");
  return invokeHostChannel<string | null>(run.projectId, CHANNELS.TERMINAL_GRACEFUL_KILL, [
    run.terminalId,
  ]);
}

/**
 * Takes a closed run's pane out. The saved layout forgets it whoever drives
 * the project, or the next window to open it would bring the closed run back,
 * and each local view showing the project drops it from its grid. Left alone
 * when the id is running again: a restart made it the user's terminal.
 */
async function removeRunPane(run: ScheduledRun): Promise<void> {
  const { terminalId } = run;
  if (terminalId === null) return;
  const live = await liveIncarnation(terminalId).catch(() => null);
  if (live !== null && live !== run.terminalSpawnedAt) return;
  const push: ScheduledRunClosedPush = { runId: run.id, terminalId };
  for (const view of getWebContentsForProject(run.projectId)) {
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
  // A no-op for a layout that never held it, so a view's own save racing
  // this can't lose anything else.
  const { forgetViewlessTerminal } = await import("../viewless/projectStateAuthoring.js");
  await forgetViewlessTerminal(projectStore, run.projectId, terminalId);
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
        console.warn(
          "[ScheduledRuns] Couldn't read environment variables for a precondition:",
          error
        );
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
