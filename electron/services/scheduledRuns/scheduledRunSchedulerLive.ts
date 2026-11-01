import { powerMonitor } from "electron";
import { randomUUID } from "node:crypto";
import { getActiveShutdown } from "../../lifecycle/shutdownCoordinator.js";
import { projectStore } from "../ProjectStore.js";
import { getScheduledRunRecorder } from "./index.js";
import { ScheduledRunScheduler } from "./ScheduledRunScheduler.js";

let scheduler: ScheduledRunScheduler | null = null;
let stopPowerEvents: (() => void) | null = null;

/**
 * Starts firing due schedules for the life of the process (#15979), with or
 * without a window: the windowed and the windowless Host boot both start it
 * from the deferred queue. Once only; never after shutdown has begun.
 */
export function startScheduledRunScheduler(): void {
  if (scheduler || getActiveShutdown() !== null) return;
  const created = new ScheduledRunScheduler({
    listProjectIds: () => projectStore.getAllProjectIdentities().map((project) => project.id),
    projectExists: (projectId) => projectStore.getProjectById(projectId) !== null,
    listSchedules: (projectId) => projectStore.schedules.list(projectId),
    subscribeSchedules: (listener) => projectStore.schedules.subscribe(listener),
    getRecorder: getScheduledRunRecorder,
    launch: async (input) => {
      const { launchScheduledRunLive } = await import("./scheduledRunLaunchLive.js");
      return launchScheduledRunLive(input);
    },
    newId: randomUUID,
    isShuttingDown: () => getActiveShutdown() !== null,
  });
  scheduler = created;

  // The raw events, not the bus's `sys:wake`: that one waits on the workspace
  // host after a resume, and the system sleep service hears only a wake whose
  // suspend it saw.
  const onSuspend = () => created.suspend();
  const onResume = () => created.resume();
  const onUnlock = () => created.unlock();
  powerMonitor.on("suspend", onSuspend);
  powerMonitor.on("resume", onResume);
  powerMonitor.on("unlock-screen", onUnlock);
  stopPowerEvents = () => {
    powerMonitor.off("suspend", onSuspend);
    powerMonitor.off("resume", onResume);
    powerMonitor.off("unlock-screen", onUnlock);
  };

  void created.start().catch((error: unknown) => {
    console.warn("[ScheduledRuns] The scheduler couldn't start:", error);
  });
}

/** Cancels its timers and listeners at shutdown, before the database closes. */
export async function stopScheduledRunScheduler(): Promise<void> {
  stopPowerEvents?.();
  stopPowerEvents = null;
  const stopping = scheduler;
  scheduler = null;
  await stopping?.dispose();
}
