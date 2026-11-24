// The Schedules actions' run bodies, loaded on first dispatch by
// scheduleActions.ts, which keeps the metadata every view registers at boot.
// Nothing here may import scheduleActions.ts at runtime.
import type { ScheduleRunNowOutcome } from "@shared/types/ipc/schedules";
import { useSchedulesViewStore } from "@/store/schedulesViewStore";
import { useProjectStore } from "@/store/projectStore";
import { schedulesClient } from "@/clients/schedulesClient";
import { requestScheduleRunConfirmation } from "@/store/scheduleRunConfirmStore";

/** Answering a confirmation can find a run opened meanwhile; each new set is asked about once. */
const MAX_OVERLAP_CONFIRMATIONS = 3;

/**
 * Run now under the schedule's overlap policy (#15980). With earlier runs
 * still open, main records nothing and asks; the user's answer goes back with
 * the runs it named, and main checks them again, so a run that opened since
 * is asked about too. Backing out runs nothing and records nothing.
 */
export async function runScheduleNow(scheduleId: string): Promise<ScheduleRunNowOutcome> {
  let outcome = await schedulesClient.runNow(scheduleId);
  for (let asked = 0; outcome.status === "confirm-overlap"; asked++) {
    if (asked >= MAX_OVERLAP_CONFIRMATIONS) return outcome;
    const approved = await requestScheduleRunConfirmation({
      scheduleName: outcome.scheduleName,
      policy: outcome.policy,
      openRunCount: outcome.openRunIds.length,
    });
    if (!approved) return outcome;
    outcome = await schedulesClient.runNow(scheduleId, {
      overlap: { policy: outcome.policy, openRunIds: outcome.openRunIds },
    });
  }
  return outcome;
}

export async function openSchedulesView(
  args: { scheduleId?: string; projectId?: string } | undefined,
  ctx: { projectId?: string }
): Promise<void> {
  const scheduleId = args?.scheduleId ?? null;
  if (args?.projectId && args.projectId !== ctx.projectId) {
    // This view can't open another project's settings: the schedule rides
    // the switch, and the incoming view opens it once its state has
    // loaded. A switch that fails reports itself.
    await useProjectStore.getState().switchProject(args.projectId, {
      focusIntent: { intent: "open-schedules", scheduleId },
    });
    return;
  }
  // The tab lands on the request once it has mounted, so a cold lazy
  // load still arrives where it was asked to.
  useSchedulesViewStore.getState().open(scheduleId);
  window.dispatchEvent(
    new CustomEvent("daintree:open-settings-tab", { detail: { tab: "project:schedules" } })
  );
}
