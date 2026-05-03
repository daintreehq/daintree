import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
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
    argsSchema: z
      .object({
        worktreeId: z.string().optional().describe("Worktree ID. Defaults to the active worktree."),
        rangeDays: PulseRangeDaysSchema,
        includeDelta: z.boolean().optional(),
        includeRecentCommits: z.boolean().optional(),
        forceRefresh: z.boolean().optional(),
      })
      .optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const merged = (args ?? {}) as {
        worktreeId?: string;
        rangeDays?: 60 | 120 | 180;
        includeDelta?: boolean;
        includeRecentCommits?: boolean;
        forceRefresh?: boolean;
      };
      const resolvedWorktreeId = merged.worktreeId ?? ctx.activeWorktreeId;
      if (!resolvedWorktreeId) throw new Error("No active worktree");
      return await window.electron.git.getProjectPulse({
        ...merged,
        worktreeId: resolvedWorktreeId,
        rangeDays: merged.rangeDays ?? 60,
      } as any);
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
      cwd: z
        .string()
        .optional()
        .describe("Repository working directory. Defaults to the active worktree path."),
      filePath: z.string(),
      status: GitStatusSchema,
    }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { cwd, filePath, status } = args as {
        cwd?: string;
        filePath: string;
        status: z.infer<typeof GitStatusSchema>;
      };
      const resolvedCwd = cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      return await window.electron.git.getFileDiff(resolvedCwd, filePath, status as any);
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
    argsSchema: z
      .object({
        cwd: z
          .string()
          .optional()
          .describe("Repository working directory. Defaults to the active worktree path."),
        search: z.string().optional(),
        branch: z.string().optional(),
        skip: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
      })
      .optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const merged = (args ?? {}) as {
        cwd?: string;
        search?: string;
        branch?: string;
        skip?: number;
        limit?: number;
      };
      const resolvedCwd = merged.cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      return await window.electron.git.listCommits({ ...merged, cwd: resolvedCwd } as any);
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
    argsSchema: z.object({
      cwd: z
        .string()
        .optional()
        .describe("Repository working directory. Defaults to the active worktree path."),
      filePath: z.string(),
    }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { cwd, filePath } = args as { cwd?: string; filePath: string };
      const resolvedCwd = cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      await window.electron.git.stageFile(resolvedCwd, filePath);
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
    argsSchema: z.object({
      cwd: z
        .string()
        .optional()
        .describe("Repository working directory. Defaults to the active worktree path."),
      filePath: z.string(),
    }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { cwd, filePath } = args as { cwd?: string; filePath: string };
      const resolvedCwd = cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      await window.electron.git.unstageFile(resolvedCwd, filePath);
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
    argsSchema: z.object({ cwd: z.string().optional() }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { cwd } = (args ?? {}) as { cwd?: string };
      const resolvedCwd = cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      await window.electron.git.stageAll(resolvedCwd);
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
    argsSchema: z.object({ cwd: z.string().optional() }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { cwd } = (args ?? {}) as { cwd?: string };
      const resolvedCwd = cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      await window.electron.git.unstageAll(resolvedCwd);
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
    argsSchema: z
      .object({ cwd: z.string().optional(), message: z.string().min(1).optional() })
      .optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { cwd, message } = (args ?? {}) as { cwd?: string; message?: string };
      const resolvedCwd = cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      const trimmed = message?.trim();
      if (!trimmed) throw new Error("Commit message is required");
      return await window.electron.git.commit(resolvedCwd, trimmed);
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
    argsSchema: z
      .object({ cwd: z.string().optional(), setUpstream: z.boolean().optional() })
      .optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { cwd, setUpstream } = (args ?? {}) as { cwd?: string; setUpstream?: boolean };
      const resolvedCwd = cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      return await window.electron.git.push(resolvedCwd, setUpstream);
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
    argsSchema: z.object({ cwd: z.string().optional() }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { cwd } = (args ?? {}) as { cwd?: string };
      const resolvedCwd = cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      return await window.electron.git.getStagingStatus(resolvedCwd);
    },
  }));

  actions.set("git.snapshotGet", () => ({
    id: "git.snapshotGet",
    title: "Get Pre-Agent Snapshot",
    description: "Get the pre-agent file snapshot for a worktree",
    category: "git",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { worktreeId } = (args ?? {}) as { worktreeId?: string };
      const resolvedWorktreeId = worktreeId ?? ctx.activeWorktreeId;
      if (!resolvedWorktreeId) throw new Error("No active worktree");
      return await window.electron.git.snapshotGet(resolvedWorktreeId);
    },
  }));

  actions.set("git.snapshotList", () => ({
    id: "git.snapshotList",
    title: "List Pre-Agent Snapshots",
    description: "List all pre-agent file snapshots",
    category: "git",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({}).optional(),
    run: async () => {
      return await window.electron.git.snapshotList();
    },
  }));

  actions.set("git.snapshotRevert", () => ({
    id: "git.snapshotRevert",
    title: "Revert Agent Changes",
    description: "Revert working tree to the pre-agent snapshot state",
    category: "git",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string() }),
    run: async (args: unknown) => {
      const { worktreeId } = args as { worktreeId: string };
      return await window.electron.git.snapshotRevert(worktreeId);
    },
  }));

  actions.set("git.snapshotDelete", () => ({
    id: "git.snapshotDelete",
    title: "Delete Pre-Agent Snapshot",
    description: "Delete the pre-agent snapshot for a worktree without reverting",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeId: z.string() }),
    run: async (args: unknown) => {
      const { worktreeId } = args as { worktreeId: string };
      await window.electron.git.snapshotDelete(worktreeId);
    },
  }));
}
