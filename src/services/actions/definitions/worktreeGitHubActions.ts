import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { githubClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { logError, logWarn } from "@/utils/logger";

export function registerWorktreeGitHubActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("worktree.openIssue", () =>
    defineAction({
      id: "worktree.openIssue",
      title: "Open Worktree Issue",
      description: "Open the GitHub issue associated with a worktree",
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
        await githubClient.openIssue(worktree.path, worktree.issueNumber);
      },
    })
  );

  actions.set("worktree.openPR", () =>
    defineAction({
      id: "worktree.openPR",
      title: "Open Worktree Pull Request",
      description: "Open the GitHub pull request associated with a worktree",
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
        if (!worktree?.prUrl) return;
        await githubClient.openPR(worktree.prUrl);
      },
    })
  );

  actions.set("worktree.openPRInPortal", () =>
    defineAction({
      id: "worktree.openPRInPortal",
      title: "Open Worktree PR in Portal",
      description: "Open the worktree's GitHub pull request in the integrated browser",
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
        if (!worktree?.prUrl) return;

        try {
          const url = new URL(worktree.prUrl);
          if (!["https:", "http:"].includes(url.protocol)) {
            logWarn(`Invalid PR URL protocol: ${url.protocol}`);
            return;
          }
        } catch (error) {
          logError(`Invalid PR URL: ${worktree.prUrl}`, error);
          return;
        }

        await actionService.dispatch(
          "portal.openUrl",
          {
            url: worktree.prUrl,
            title: worktree.prTitle || `PR #${worktree.prNumber}`,
            background: false,
          },
          { source: "user" }
        );
      },
      isEnabled: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return false;
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        return typeof worktree?.prUrl === "string" && worktree.prUrl.trim().length > 0;
      },
      disabledReason: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return "No worktree selected";
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        if (typeof worktree?.prUrl !== "string" || worktree.prUrl.trim().length === 0)
          return "Worktree has no associated PR";
        return undefined;
      },
    })
  );

  actions.set("worktree.openIssueInPortal", () =>
    defineAction({
      id: "worktree.openIssueInPortal",
      title: "Open Worktree Issue in Portal",
      description: "Open the worktree's GitHub issue in the integrated browser",
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

        const issueUrl = await githubClient.getIssueUrl(worktree.path, worktree.issueNumber);
        if (!issueUrl) return;

        await actionService.dispatch(
          "portal.openUrl",
          {
            url: issueUrl,
            title: worktree.issueTitle || `Issue #${worktree.issueNumber}`,
            background: false,
          },
          { source: "user" }
        );
      },
      isEnabled: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return false;
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        return typeof worktree?.issueNumber === "number" && worktree.issueNumber > 0;
      },
      disabledReason: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return "No worktree selected";
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        if (typeof worktree?.issueNumber !== "number" || worktree.issueNumber <= 0)
          return "Worktree has no associated issue";
        return undefined;
      },
    })
  );
}
