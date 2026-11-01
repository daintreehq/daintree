import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import type { ActionDispatchResult } from "@shared/types/actions";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/**
 * Launches the scheduled runs main hands this view (#15978), so a run's pane
 * appears in this window's grid at once and this view's persistence saves it.
 *
 * The run is host-stamped provenance (`scheduledRun`), never an argument.
 * Dispatched as `"agent"`, the source of work no keystroke asked for, so it
 * never becomes the action Repeat Last replays; `confirmed` is main's
 * attestation that the user configured this launch when they saved the
 * schedule. Main registers the run when the terminal spawns, and reads this
 * answer only for why a launch started nothing.
 */
export function useScheduledRunLaunchBridge(): void {
  useEffect(() => {
    const schedules = window.electron?.schedules;
    if (!schedules?.onLaunchRequest) return;
    let disposed = false;
    const cleanup = schedules.onLaunchRequest(({ requestId, args, scheduledRun }) => {
      void (async () => {
        let result: ActionDispatchResult;
        try {
          result = await actionService.dispatch("agent.launch", args, {
            source: "agent",
            confirmed: true,
            scheduledRun,
          });
        } catch (error) {
          result = {
            ok: false,
            error: {
              code: "EXECUTION_ERROR",
              message: formatErrorMessage(error, "The scheduled run's launch failed"),
            },
          };
        }
        if (disposed) return;
        try {
          schedules.sendLaunchResponse({ requestId, result });
        } catch {
          // Main's wait runs out instead, and the spawn's admission still decides.
        }
      })();
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, []);
}
