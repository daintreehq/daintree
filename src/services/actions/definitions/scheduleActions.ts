import { z } from "zod";
import type { ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import type { ActionContext } from "@shared/types/actions";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { useSchedulesViewStore } from "@/store/schedulesViewStore";
import { ClientAppError } from "@/utils/clientAppError";

// Schedules live on this machine and run agents here, so a window driving a
// Remote Host's project, or a scratch, has none to show (#15973).
function canShowSchedules(ctx: ActionContext): boolean {
  return Boolean(ctx.projectId) && !isRemoteWindow();
}

export function registerScheduleActions(actions: ActionRegistry): void {
  actions.set("schedules.open", () =>
    defineAction({
      id: "schedules.open",
      title: "Schedules…",
      description:
        "Open the Schedules view for the current project: its scheduled agent runs, when each runs next, and an editor for each",
      category: "project",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      keywords: ["schedule", "cron", "recurring", "nightly", "timer", "automation"],
      nonRepeatable: true,
      // UI navigation for people. In no assistant or external tier (#15973),
      // and hidden from tool listings: an agent has nothing to gain from it.
      mcpVisibility: "hidden",
      argsSchema: z
        .object({
          scheduleId: z.string().min(1).optional().describe("Open at this schedule's page"),
        })
        .optional(),
      isEnabled: canShowSchedules,
      disabledReason: (ctx) =>
        canShowSchedules(ctx)
          ? undefined
          : "Schedules are for projects on this machine. Open one to manage its schedules",
      run: async (args: { scheduleId?: string } | undefined, ctx: ActionContext) => {
        if (!canShowSchedules(ctx)) {
          throw new ClientAppError(
            "UNSUPPORTED",
            "No local project to show schedules for",
            "Schedules are for projects on this machine."
          );
        }
        useSchedulesViewStore.getState().open(args?.scheduleId ?? null);
      },
    })
  );

  // An agent running unattended is configured only in Daintree's own UI, so
  // Run now is on no MCP tier and closed to plugins: a plugin may give an
  // agent a task, never launch one with a schedule's preset (#15978).
  actions.set("schedules.runNow", () =>
    defineAction({
      id: "schedules.runNow",
      title: "Run schedule now",
      description:
        "Launch a schedule's agent now, with its preset and prompt in its worktree, as a run recorded in the schedule's history. Runs whether or not the schedule is enabled.",
      category: "project",
      kind: "command",
      danger: "safe",
      denyPluginDispatch: true,
      mcpVisibility: "hidden",
      scope: "renderer",
      keywords: ["schedule", "scheduled", "run", "now", "agent"],
      // It names one schedule; the Schedules view is where one is picked.
      palette: { mode: "hidden" },
      argsSchema: z.object({
        scheduleId: z.string().min(1).max(200).describe("The schedule to run, from this project."),
      }),
      run: async ({ scheduleId }: { scheduleId: string }) =>
        window.electron.schedules.runNow(scheduleId),
    })
  );
}
