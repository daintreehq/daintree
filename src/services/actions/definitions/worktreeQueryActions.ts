import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import { WorktreeSummarySchema } from "./schemas";
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
    resultSchema: z.object({ worktrees: z.array(WorktreeSummarySchema) }),
    run: async () => {
      const worktrees = callbacks.getWorktrees();
      const activeWorktreeId = callbacks.getActiveWorktreeId();

      const result = worktrees.map((w) => ({
        id: w.id,
        path: w.path,
        branch: w.branch,
        isActive: w.id === activeWorktreeId,
        isMain: w.isMainWorktree ?? false,
        issueNumber: w.issueNumber ?? null,
        issueTitle: w.issueTitle ?? null,
        prNumber: w.linked?.pr?.ref.number ?? null,
        prTitle: w.linked?.pr?.title ?? null,
        prUrl: w.linked?.pr?.url ?? null,
        status: w.mood ?? null,
        lastCommit: w.summary ?? null,
      }));

      return { worktrees: result };
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
    resultSchema: z.object({ worktree: WorktreeSummarySchema.nullable() }),
    run: async () => {
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      if (!activeWorktreeId) {
        return { worktree: null };
      }

      const worktree = getCurrentViewStore().getState().worktrees.get(activeWorktreeId);
      if (!worktree) {
        return { worktree: null };
      }

      const result = {
        id: worktree.id,
        path: worktree.path,
        branch: worktree.branch,
        isMain: worktree.isMainWorktree ?? false,
        issueNumber: worktree.issueNumber ?? null,
        issueTitle: worktree.issueTitle ?? null,
        prNumber: worktree.linked?.pr?.ref.number ?? null,
        prTitle: worktree.linked?.pr?.title ?? null,
        prUrl: worktree.linked?.pr?.url ?? null,
        status: worktree.mood ?? null,
        lastCommit: worktree.summary ?? null,
      };

      return { worktree: result };
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
      resultSchema: z.object({
        branches: z.array(
          z.object({
            name: z.string(),
            current: z.boolean(),
            commit: z.string(),
            remote: z.string().optional(),
          })
        ),
      }),
      run: async ({ rootPath }) => {
        const result = await worktreeClient.listBranches(rootPath);
        return { branches: result };
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
      resultSchema: z.object({ path: z.string() }),
      run: async ({ rootPath, branchName }) => {
        const result = await worktreeClient.getDefaultPath(rootPath, branchName);
        return { path: result };
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
      resultSchema: z.object({ branch: z.string() }),
      run: async ({ rootPath, branchName }) => {
        const result = await worktreeClient.getAvailableBranch(rootPath, branchName);
        return { branch: result };
      },
    })
  );
}
