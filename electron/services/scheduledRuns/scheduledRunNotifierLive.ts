import { getActiveShutdown } from "../../lifecycle/shutdownCoordinator.js";
import { openScheduledRunFromNotification } from "../../window/scheduledRunNotificationNavigation.js";
import { agentNotificationService } from "../AgentNotificationService.js";
import { notificationService } from "../NotificationService.js";
import { projectStore } from "../ProjectStore.js";
import { soundService } from "../SoundService.js";
import type { Schedule, ScheduledRun } from "../../../shared/types/scheduledRuns.js";
import { getEffectiveRegistry } from "../../../shared/config/agentRegistry.js";
import { isScheduledQuietNow } from "../../../shared/utils/quietHours.js";
import { describeScheduledRunAttention, type ScheduledRunAttention } from "./scheduledRunAttention.js";

async function readSchedule(run: ScheduledRun): Promise<Schedule | null> {
  try {
    return await projectStore.schedules.get(run.projectId, run.scheduleId);
  } catch (error) {
    console.warn(`[ScheduledRuns] Couldn't read the schedule of run ${run.id} to notify:`, error);
    return null;
  }
}

/** Whether this machine's settings hold the banner back now: off, quiet hours, or a session mute. */
function isHeldBack(projectId: string): boolean {
  const settings = projectStore.getEffectiveNotificationSettings(projectId);
  return (
    settings.enabled === false ||
    isScheduledQuietNow(settings) ||
    agentNotificationService.isSessionMuted()
  );
}

/**
 * Puts up the banner for a run that needs a person, on this machine: the one
 * running the schedule. It names no owning view, so it is never handed to a
 * remote Shell, and its click is handled here, which also works with no
 * window open. Quiet hours, the session mute and notifications being off hold
 * it back, read again after the schedule is, so a mute set meanwhile counts.
 */
export async function notifyScheduledRunAttention(
  run: ScheduledRun,
  attention: ScheduledRunAttention
): Promise<void> {
  if (getActiveShutdown() !== null || isHeldBack(run.projectId)) return;
  const schedule = await readSchedule(run);
  if (getActiveShutdown() !== null || isHeldBack(run.projectId)) return;

  const agentId = run.resume?.agentId ?? schedule?.launch.agentId;
  const agentName = (agentId ? getEffectiveRegistry()[agentId]?.name?.trim() : "") || "The agent";
  const { title, body } = describeScheduledRunAttention(attention, {
    scheduleName: schedule?.name ?? null,
    agentName,
  });

  const settings = projectStore.getEffectiveNotificationSettings(run.projectId);
  if (settings.soundEnabled) soundService.playFile(settings.waitingSoundFile);
  notificationService.showNativeNotification(title, body, {
    category: "waiting",
    onClick: () =>
      openScheduledRunFromNotification({
        projectId: run.projectId,
        scheduleId: run.scheduleId,
        runId: run.id,
        terminalId: attention.kind === "launch-failed" ? null : run.terminalId,
      }),
  });
}
