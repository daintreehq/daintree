import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { forgeClient, systemClient } from "@/clients";
import { getCurrentViewStore } from "@/store/createWorktreeStore";

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
        if (!targetWorktreeId) throw new Error("No active worktree");
        const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
        if (!worktree) throw new Error("Worktree not found");
        if (!worktree.issueNumber) throw new Error("Worktree has no associated issue");
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
        if (!targetWorktreeId) throw new Error("No active worktree");
        const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
        if (!worktree) throw new Error("Worktree not found");
        if (!worktree.linked?.pr?.url) {
          throw new Error("Worktree has no associated pull request");
        }

        const prUrl = worktree.linked.pr.url;
        let url: URL;
        try {
          url = new URL(prUrl);
        } catch {
          throw new Error(`Pull request URL is invalid: ${prUrl}`);
        }
        if (!["https:", "http:"].includes(url.protocol)) {
          throw new Error(`Pull request URL must use http(s): ${prUrl}`);
        }

        await systemClient.openExternal(prUrl);
      },
    })
  );
}
