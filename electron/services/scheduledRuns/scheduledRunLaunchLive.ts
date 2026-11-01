import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import {
  getWebContentsForProject,
  isCachedViewWebContents,
} from "../../window/webContentsRegistry.js";
import { projectStore } from "../ProjectStore.js";
import type { ScheduleRunNowOutcome } from "../../../shared/types/ipc/schedules.js";
import type { ScheduledRunOrigin } from "../../../shared/types/scheduledRuns.js";
import { getScheduledRunRecorder } from "./index.js";
import { launchScheduledRun, type ScheduledRunLauncherDeps } from "./ScheduledRunLauncher.js";
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

async function liveDeps(): Promise<ScheduledRunLauncherDeps<Electron.WebContents>> {
  const [{ isProjectSleepInFlight }, { runScheduledAgentLaunchLive }] = await Promise.all([
    import("../projectSleep.js"),
    import("../viewless/index.js"),
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
    newId: randomUUID,
  };
}

/** Launches a schedule's agent as a tracked run; see {@link launchScheduledRun}. */
export async function launchScheduledRunLive(input: {
  projectId: string;
  scheduleId: string;
  origin: ScheduledRunOrigin;
  preferredWebContentsId?: number;
}): Promise<ScheduleRunNowOutcome> {
  return launchScheduledRun(input, await liveDeps());
}
