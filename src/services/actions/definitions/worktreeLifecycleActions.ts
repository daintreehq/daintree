import type { ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { worktreeClient } from "@/clients";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export function registerWorktreeLifecycleActions(actions: ActionRegistry): void {
  actions.set("worktree.lifecycle.retrySetup", () =>
    defineAction({
      id: "worktree.lifecycle.retrySetup",
      title: "Retry setup",
      description: "Re-run the worktree lifecycle setup script in place",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      isEnabled: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return false;
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        const state = worktree?.lifecycleStatus?.state;
        return state === "failed" || state === "timed-out";
      },
      disabledReason: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return "No worktree selected";
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        const state = worktree?.lifecycleStatus?.state;
        if (state === "running") return "Setup is already running";
        if (state !== "failed" && state !== "timed-out") {
          return "No failed setup to retry";
        }
        return undefined;
      },
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) throw new Error("No worktree selected");
        try {
          await worktreeClient.retrySetup(targetWorktreeId);
        } catch (err) {
          const message = formatErrorMessage(err, "Setup retry failed") || "Setup retry failed";
          notify({
            type: "error",
            priority: "high",
            title: "Setup retry failed",
            message,
            action: {
              label: "Copy details",
              successLabel: "Copied",
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(message);
                } catch {
                  // clipboard write is non-critical
                }
              },
            },
          });
        }
      },
    })
  );
}
