import os from "node:os";
import { app } from "electron";
import { getActiveShutdown } from "../../lifecycle/shutdownCoordinator.js";
import { runCommand } from "../../utils/runCommand.js";
import { projectStore } from "../ProjectStore.js";
import type { ScheduleOsJobStatus } from "../../../shared/types/ipc/schedules.js";
import { createLaunchAgentScheduleJob, launchAgentTargetFor } from "./launchAgentScheduleJob.js";
import { scheduleOsJobContext } from "./scheduleOsJobContext.js";
import { ScheduleOsJobService, excludedSchedules } from "./ScheduleOsJobService.js";

const BUNDLE_ID = "org.daintree.app";
/** A dev build runs inside Electron.app, which is what macOS attributes the job to. */
const DEV_BUNDLE_ID = "com.github.Electron";

let service: ScheduleOsJobService | null = null;

/** macOS only until Linux (#15991) and Windows (#15993) have theirs. Never once shutdown began. */
function getService(): ScheduleOsJobService | null {
  if (service || process.platform !== "darwin" || getActiveShutdown() !== null) return service;
  const userDataDir = app.getPath("userData");
  service = new ScheduleOsJobService({
    adapter: createLaunchAgentScheduleJob({
      homeDir: os.homedir(),
      uid: process.getuid!(),
      userDataDir,
      target: launchAgentTargetFor({
        execPath: process.execPath,
        appPath: process.defaultApp ? app.getAppPath() : null,
        userDataDir,
        bundleId: app.isPackaged ? BUNDLE_ID : DEV_BUNDLE_ID,
      }),
      run: runCommand,
    }),
    listProjectIds: () => projectStore.getAllProjectIdentities().map((project) => project.id),
    listSchedules: (projectId) => projectStore.schedules.list(projectId),
    subscribeSchedules: (listener) => projectStore.schedules.subscribe(listener),
    context: () => scheduleOsJobContext(),
  });
  return service;
}

/**
 * Brings the OS job up to date for the life of the process, with or without a
 * window. Its first pass is what repairs a job left by an app that has moved.
 */
export function startScheduleOsJob(): void {
  void getService()
    ?.start()
    .catch((error: unknown) => {
      console.warn("[ScheduleOsJob] Couldn't start:", error);
    });
}

/** Where there's no job, every opted-in schedule of the project is listed with why. */
async function statusWithoutJob(projectId: string): Promise<ScheduleOsJobStatus> {
  const context = scheduleOsJobContext();
  const { schedules } = await projectStore.schedules.list(projectId);
  return {
    context,
    unavailable: null,
    state: "none",
    error: null,
    excluded: excludedSchedules(schedules, context),
  };
}

export async function scheduleOsJobStatus(projectId: string): Promise<ScheduleOsJobStatus> {
  const running = getService();
  return running ? running.status(projectId) : statusWithoutJob(projectId);
}

export async function repairScheduleOsJob(projectId: string): Promise<ScheduleOsJobStatus> {
  const running = getService();
  return running ? running.repair(projectId) : statusWithoutJob(projectId);
}

/** At quit: stops following changes once a rewrite under way has landed. The job stays installed. */
export async function stopScheduleOsJob(): Promise<void> {
  const stopping = service;
  service = null;
  await stopping?.dispose();
}
