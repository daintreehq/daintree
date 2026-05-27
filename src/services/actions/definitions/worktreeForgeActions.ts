import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { forgeClient, systemClient } from "@/clients";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { logError, logWarn } from "@/utils/logger";

export function registerWorktreeForgeActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("worktree.openIssue", () =>
    defineAction({
      id: "worktree.openIssue",
      title: "Open Worktree Issue",
      description: "Open the issue associated with a worktree",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) return;
        const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
        if (!worktree?.issueNumber) return;
        await forgeClient.openIssue(worktree.path, worktree.issueNumber);
      },
    })
  );

  actions.set("worktree.openPR", () =>
    defineAction({
      id: "worktree.openPR",
      title: "Open Worktree Pull Request",
      description: "Open the pull request associated with a worktree",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) return;
        const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
        if (!worktree?.linked?.pr?.url) return;

        try {
          const url = new URL(worktree.linked.pr.url);
          if (!["https:", "http:"].includes(url.protocol)) {
            logWarn(`Invalid PR URL protocol: ${url.protocol}`);
            return;
          }
        } catch (error) {
          logError(`Invalid PR URL: ${worktree.linked.pr.url}`, error);
          return;
        }

        await systemClient.openExternal(worktree.linked.pr.url);
      },
    })
  );
}
