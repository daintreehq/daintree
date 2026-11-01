import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { app } from "electron";
import { getActiveShutdown } from "../../lifecycle/shutdownCoordinator.js";
import { runningAppImage } from "../../utils/appImage.js";
import { runCommand } from "../../utils/runCommand.js";
import { APPIMAGE_EXTRACT_AND_RUN_ENV } from "../../utils/systemdUnit.js";
import { onAppImageRelocated } from "../appImageRelocation.js";
import { projectStore } from "../ProjectStore.js";
import type { ScheduleOsJobStatus } from "../../../shared/types/ipc/schedules.js";
import { createLaunchAgentScheduleJob, launchAgentTargetFor } from "./launchAgentScheduleJob.js";
import { scheduleOsJobContext } from "./scheduleOsJobContext.js";
import {
  ScheduleOsJobService,
  excludedSchedules,
  type ScheduleOsJobAdapter,
} from "./ScheduleOsJobService.js";
import {
  createSystemdScheduleJob,
  systemdScheduleTargetFor,
  type SystemdScheduleJob,
} from "./systemdScheduleJob.js";

const BUNDLE_ID = "org.daintree.app";
/** A dev build runs inside Electron.app, which is what macOS attributes the job to. */
const DEV_BUNDLE_ID = "com.github.Electron";

let service: ScheduleOsJobService | null = null;
/**
 * The Linux job an AppImage move is followed for. Kept past the service's
 * stop: the updater moves the image after the shutdown chain has run.
 */
let movingJob: SystemdScheduleJob | null = null;
let followingMoves = false;

function systemdJob(userDataDir: string): SystemdScheduleJob {
  const appImage = runningAppImage();
  const job = createSystemdScheduleJob({
    homeDir: os.homedir(),
    userDataDir,
    target: systemdScheduleTargetFor({
      execPath: process.execPath,
      appImage,
      appPath: process.defaultApp ? app.getAppPath() : null,
      userDataDir,
      appImageExtractAndRun: process.env[APPIMAGE_EXTRACT_AND_RUN_ENV] === "1",
      devNoSandbox: !app.isPackaged && process.argv.includes("--no-sandbox"),
      // Where systemd is the init system (sd_booted).
      systemdRunning: fs.existsSync("/run/systemd/system"),
    }),
    run: runCommand,
    reloadSync: () => {
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore", timeout: 5_000 });
    },
  });
  movingJob = job;
  if (appImage !== null && !followingMoves) {
    followingMoves = true;
    onAppImageRelocated((relocation) => movingJob?.followAppImageMove(relocation));
  }
  return job;
}

function osJobAdapter(userDataDir: string): ScheduleOsJobAdapter | null {
  if (process.platform === "darwin") {
    return createLaunchAgentScheduleJob({
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
    });
  }
  if (process.platform === "linux") return systemdJob(userDataDir);
  return null;
}

/** macOS and Linux until Windows (#15993) has its own. Never once shutdown began. */
function getService(): ScheduleOsJobService | null {
  if (service || getActiveShutdown() !== null) return service;
  const userDataDir = app.getPath("userData");
  const adapter = osJobAdapter(userDataDir);
  if (!adapter) return null;
  service = new ScheduleOsJobService({
    adapter,
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
