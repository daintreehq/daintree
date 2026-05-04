import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { worktreeClient } from "@/clients";

export function registerWorktreeQueryActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("worktree.list", () => ({
    id: "worktree.list",
    title: "List Worktrees",
    description: "Get list of all worktrees with status information",
    category: "worktree",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const worktrees = callbacks.getWorktrees();
      const activeWorktreeId = callbacks.getActiveWorktreeId();

      return worktrees.map((w) => ({
        id: w.id,
        path: w.path,
        branch: w.branch,
        isActive: w.id === activeWorktreeId,
        isMain: w.isMainWorktree ?? false,
        issueNumber: w.issueNumber ?? null,
        issueTitle: w.issueTitle ?? null,
        prNumber: w.prNumber ?? null,
        prTitle: w.prTitle ?? null,
        prUrl: w.prUrl ?? null,
        status: w.mood ?? null,
        lastCommit: w.summary ?? null,
      }));
    },
  }));

  actions.set("worktree.getCurrent", () => ({
    id: "worktree.getCurrent",
    title: "Get Current Worktree",
    description: "Get the currently active worktree details",
    category: "worktree",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      if (!activeWorktreeId) {
        return null;
      }

      const worktree = getCurrentViewStore().getState().worktrees.get(activeWorktreeId);
      if (!worktree) {
        return null;
      }

      return {
        id: worktree.id,
        path: worktree.path,
        branch: worktree.branch,
        isMain: worktree.isMainWorktree ?? false,
        issueNumber: worktree.issueNumber ?? null,
        issueTitle: worktree.issueTitle ?? null,
        prNumber: worktree.prNumber ?? null,
        prTitle: worktree.prTitle ?? null,
        prUrl: worktree.prUrl ?? null,
        status: worktree.mood ?? null,
        lastCommit: worktree.summary ?? null,
      };
    },
  }));

  actions.set("worktree.listBranches", () =>
    defineAction({
      id: "worktree.listBranches",
      title: "List Branches",
      description: "List git branches for a repository root",
      category: "worktree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ rootPath: z.string() }),
      run: async ({ rootPath }) => {
        return await worktreeClient.listBranches(rootPath);
      },
    })
  );

  actions.set("worktree.getDefaultPath", () =>
    defineAction({
      id: "worktree.getDefaultPath",
      title: "Get Default Worktree Path",
      description: "Get the default path for a new worktree based on branch and config",
      category: "worktree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ rootPath: z.string(), branchName: z.string() }),
      run: async ({ rootPath, branchName }) => {
        return await worktreeClient.getDefaultPath(rootPath, branchName);
      },
    })
  );

  actions.set("worktree.getAvailableBranch", () =>
    defineAction({
      id: "worktree.getAvailableBranch",
      title: "Get Available Branch Name",
      description:
        "Get a collision-safe branch name. Returns the original name if available, or a numbered variant if the branch exists.",
      category: "worktree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ rootPath: z.string(), branchName: z.string() }),
      run: async ({ rootPath, branchName }) => {
        return await worktreeClient.getAvailableBranch(rootPath, branchName);
      },
    })
  );
}
