import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { forgeClient, systemClient } from "@/clients";
import { actionService } from "@/services/ActionService";
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

  actions.set("worktree.openPRInPortal", () =>
    defineAction({
      id: "worktree.openPRInPortal",
      title: "Open Worktree PR in Portal",
      description: "Open the worktree's pull request in the integrated browser",
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

        await actionService.dispatch(
          "portal.openUrl",
          {
            url: worktree.linked.pr.url,
            title: worktree.linked.pr.title || `PR #${worktree.linked.pr.ref.number}`,
            background: false,
          },
          { source: "user" }
        );
      },
      isEnabled: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return false;
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        return (
          typeof worktree?.linked?.pr?.url === "string" && worktree.linked.pr.url.trim().length > 0
        );
      },
      disabledReason: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return "No worktree selected";
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        if (
          typeof worktree?.linked?.pr?.url !== "string" ||
          worktree.linked.pr.url.trim().length === 0
        )
          return "Worktree has no associated PR";
        return undefined;
      },
    })
  );

  actions.set("worktree.openIssueInPortal", () =>
    defineAction({
      id: "worktree.openIssueInPortal",
      title: "Open Worktree Issue in Portal",
      description: "Open the worktree's issue in the integrated browser",
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

        const issueUrl = await forgeClient.getIssueUrl(worktree.path, worktree.issueNumber);
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
