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

  actions.set("git.stageFile", () => ({
    id: "git.stageFile",
    title: "Stage File",
    description: "Stage a file for commit",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ cwd: z.string(), filePath: z.string() }),
    run: async (args: unknown) => {
      const { cwd, filePath } = args as { cwd: string; filePath: string };
      await window.electron.git.stageFile(cwd, filePath);
    },
  }));

  actions.set("git.unstageFile", () => ({
    id: "git.unstageFile",
    title: "Unstage File",
    description: "Unstage a file from the index",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ cwd: z.string(), filePath: z.string() }),
    run: async (args: unknown) => {
      const { cwd, filePath } = args as { cwd: string; filePath: string };
      await window.electron.git.unstageFile(cwd, filePath);
    },
  }));

  actions.set("git.stageAll", () => ({
    id: "git.stageAll",
    title: "Stage All Files",
    description: "Stage all changes for commit",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ cwd: z.string() }),
    run: async (args: unknown) => {
      const { cwd } = args as { cwd: string };
      await window.electron.git.stageAll(cwd);
    },
  }));

  actions.set("git.unstageAll", () => ({
    id: "git.unstageAll",
    title: "Unstage All Files",
    description: "Unstage all files from the index",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ cwd: z.string() }),
    run: async (args: unknown) => {
      const { cwd } = args as { cwd: string };
      await window.electron.git.unstageAll(cwd);
    },
  }));

  actions.set("git.commit", () => ({
    id: "git.commit",
    title: "Commit",
    description: "Commit staged changes with a message",
    category: "git",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ cwd: z.string(), message: z.string().min(1) }),
    run: async (args: unknown) => {
      const { cwd, message } = args as { cwd: string; message: string };
      return await window.electron.git.commit(cwd, message);
    },
  }));

  actions.set("git.push", () => ({
    id: "git.push",
    title: "Push",
    description: "Push commits to remote",
    category: "git",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ cwd: z.string(), setUpstream: z.boolean().optional() }),
    run: async (args: unknown) => {
      const { cwd, setUpstream } = args as { cwd: string; setUpstream?: boolean };
      return await window.electron.git.push(cwd, setUpstream);
    },
  }));

  actions.set("git.getStagingStatus", () => ({
    id: "git.getStagingStatus",
    title: "Get Staging Status",
    description: "Get the current staging status of files",
    category: "git",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ cwd: z.string() }),
    run: async (args: unknown) => {
      const { cwd } = args as { cwd: string };
      return await window.electron.git.getStagingStatus(cwd);
    },
  }));
}
