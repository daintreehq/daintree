import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { GitStatusSchema, PulseRangeDaysSchema } from "./schemas";
import { z } from "zod";

export function registerGitActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("git.getProjectPulse", () => ({
    id: "git.getProjectPulse",
    title: "Get Project Pulse",
    description: "Get git activity pulse for a worktree",
    category: "git",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      worktreeId: z.string(),
      rangeDays: PulseRangeDaysSchema,
      includeDelta: z.boolean().optional(),
      includeRecentCommits: z.boolean().optional(),
      forceRefresh: z.boolean().optional(),
    }),
    run: async (args: unknown) => {
      return await window.electron.git.getProjectPulse(args as any);
    },
  }));

  actions.set("git.getFileDiff", () => ({
    id: "git.getFileDiff",
    title: "Get File Diff",
    description: "Get git diff for a file",
    category: "git",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      cwd: z.string(),
      filePath: z.string(),
      status: GitStatusSchema,
    }),
    run: async (args: unknown) => {
      const { cwd, filePath, status } = args as {
        cwd: string;
        filePath: string;
        status: z.infer<typeof GitStatusSchema>;
      };
      return await window.electron.git.getFileDiff(cwd, filePath, status as any);
    },
  }));

  actions.set("git.listCommits", () => ({
    id: "git.listCommits",
    title: "List Commits",
    description: "List git commits for a repository",
    category: "git",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      cwd: z.string(),
      search: z.string().optional(),
      branch: z.string().optional(),
      skip: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    }),
    run: async (args: unknown) => {
      return await window.electron.git.listCommits(args as any);
    },
  }));

  // ============================================
}
