import { powerMonitor } from "electron";
import { randomUUID } from "node:crypto";
import { isDueScheduleCheckRequested } from "../../boot/dueScheduleLaunch.js";
import { getActiveShutdown } from "../../lifecycle/shutdownCoordinator.js";
import { projectStore } from "../ProjectStore.js";
import { getScheduledRunRecorder } from "./index.js";
import { cancelScheduledLaunches } from "./scheduledRunAdmission.js";
import { ScheduledRunScheduler } from "./ScheduledRunScheduler.js";

let scheduler: ScheduledRunScheduler | null = null;
let stopPowerEvents: (() => void) | null = null;
/** The OS job's launch is this process's start, given to the first scheduler only. */
let osLaunchTaken = false;

/**
 * When an OS job started this process (#15989), on the wall clock and the
 * monotonic one (`performance.now()` counts from `timeOrigin`).
 */
function takeOsLaunch(): { at: number; monotonicAt: number } | null {
  if (osLaunchTaken) return null;
  osLaunchTaken = true;
  return isDueScheduleCheckRequested(process.argv)
    ? { at: performance.timeOrigin, monotonicAt: 0 }
    : null;
}

/**
 * Starts firing due schedules for the life of the process (#15979), with or
 * without a window: the windowed and the windowless boots start it from the
 * deferred queue. Once only; never after shutdown has begun.
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
    cancelLaunches: (scheduleId) => cancelScheduledLaunches({ scheduleId, automaticOnly: true }),
    newId: randomUUID,
    isShuttingDown: () => getActiveShutdown() !== null,
    osLaunch: takeOsLaunch(),
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

/**
 * An OS job's launch reached this running Daintree (#15989): every schedule is
 * looked at now. Before the scheduler starts there's nothing to do, since its
 * first pass is still to come.
 */
export function checkDueSchedules(): void {
  scheduler?.check();
}

/** Cancels its timers and listeners at shutdown, before the database closes. */
export async function stopScheduledRunScheduler(): Promise<void> {
  stopPowerEvents?.();
  stopPowerEvents = null;
  const stopping = scheduler;
  scheduler = null;
  await stopping?.dispose();
}
