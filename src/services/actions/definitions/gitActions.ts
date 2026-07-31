import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { GitStatusSchema, PulseRangeDaysSchema } from "./schemas";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import { z } from "zod";

export function registerGitActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("git.getProjectPulse", () => ({
    id: "git.getProjectPulse",
    title: "Get Project Pulse",
    description:
      "Get a worktree's git activity pulse — historical commit heatmap, range counts, streak, and optional uncommitted/delta-to-main summary. Args (all optional): `worktreeId` (from `worktree.list`, defaults to active); `rangeDays` (60|120|180); `includeDelta`; `includeRecentCommits`; `forceRefresh`. Returns worktree/branch info, heatmap, commitsInRange, activeDays, projectAgeDays, recentCommits, and optional uncommitted/deltaToMain. Errors when no worktree is active. Do NOT use this for current staged/unstaged state — use `git.getStagingStatus`.",
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
    resultSchema: z.object({
      worktreeId: z.string(),
      worktreePath: z.string(),
      branch: z.string().optional(),
      mainBranch: z.string(),
      rangeDays: PulseRangeDaysSchema,
      generatedAt: z.number(),
      heatmap: z.array(z.unknown()),
      commitsInRange: z.number(),
      activeDays: z.number(),
      projectAgeDays: z.number(),
      currentStreakDays: z.number().optional(),
      recentCommits: z.array(z.unknown()),
      uncommitted: z
        .object({
          changedFiles: z.number(),
          insertions: z.number().optional(),
          deletions: z.number().optional(),
          lastUpdated: z.number().optional(),
        })
        .optional(),
      deltaToMain: z.unknown().optional(),
    }),
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
    description:
      "Get the git diff for a single file. Args: `cwd` (optional) — repo working directory, defaults to the active worktree path; `filePath` (required) — repo-relative path; `status` (required) — the file's git status (from a `git.getStagingStatus` entry); `ignoreWhitespace` (optional) — omit whitespace-only changes. Returns { content } — the unified diff text. Errors when `cwd` is omitted and no worktree is active.",
    category: "git",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      cwd: z
        .string()
        .optional()
        .describe("Repository working directory. Defaults to the active worktree path."),
      filePath: z
        .string()
        .describe("Repo-relative file path (from a `git.getStagingStatus` entry)."),
      status: GitStatusSchema.describe(
        "The file's git status — the `status` value from a `git.getStagingStatus` entry."
      ),
      ignoreWhitespace: z
        .boolean()
        .optional()
        .describe("When true, whitespace-only changes are omitted from the diff."),
    }),
    examples: [
      {
        args: { filePath: "src/index.css", status: "modified" },
        description: "Get the diff for a modified file in the active worktree",
      },
    ],
    resultSchema: z.object({ content: z.string() }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { cwd, filePath, status, ignoreWhitespace } = args as {
        cwd?: string;
        filePath: string;
        status: z.infer<typeof GitStatusSchema>;
        ignoreWhitespace?: boolean;
      };
      const resolvedCwd = cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      const diff = await window.electron.git.getFileDiff(
        resolvedCwd,
        filePath,
        status as any,
        ignoreWhitespace
      );
      return { content: diff };
    },
  }));

  actions.set("git.listCommits", () => ({
    id: "git.listCommits",
    title: "List Commits",
    description:
      "List commits for a repository with optional search and pagination. Args (all optional): `cwd` (repo dir, defaults to the active worktree path); `search` (message/author filter); `branch`; `skip`/`limit` for paging. Returns { items, hasMore, total }. Errors when `cwd` is omitted and no worktree is active.",
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
    resultSchema: z.object({
      items: z.array(z.unknown()),
      hasMore: z.boolean(),
      total: z.number(),
    }),
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
    danger: "safe",
    scope: "renderer",
    keywords: ["commit", "stage", "review", "changes"],
    // Headless/MCP tool: run() requires an authored commit `message` and throws
    // without one. Per the #7880 no-silent-fallback rule, a palette "Commit"
    // must never derive a message — redirect to the Review Hub, which shows the
    // staged files and requires the user to type the message before committing.
    palette: { mode: "redirect", to: "worktree.openReviewHub" },
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
    dangerRationale: "Pushes local commits to the remote. Recovery requires a force-push to undo.",
    argsSchema: z
      .object({ cwd: z.string().optional(), setUpstream: z.boolean().optional() })
      .optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { cwd, setUpstream } = (args ?? {}) as { cwd?: string; setUpstream?: boolean };
      const resolvedCwd = cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      // Palette/keybinding/user sources reach run() ungated, so enforce the D2
      // push preview here (#8242) — the dialog shows the target branch and the
      // commits that would be pushed before the IPC fires. An agent dispatch
      // that reaches run() has ALREADY cleared ActionService's host-attested
      // confirm gate via the MCP bridge, which surfaces the same fresh
      // branch/commit preview in its own modal. Re-requesting here would
      // double-prompt, and this store resolves only from a renderer dialog no
      // headless MCP client can click — so the push would hang forever (#11538).
      if (ctx.dispatchSource !== "agent") {
        const confirmed = await useGitPushConfirmStore.getState().requestConfirmation(resolvedCwd);
        if (!confirmed) return;
      }
      return await window.electron.git.push(resolvedCwd, setUpstream);
    },
  }));

  actions.set("git.pullRebase", () => ({
    id: "git.pullRebase",
    title: "Pull and Rebase",
    description: "Pull remote changes and rebase local commits",
    category: "git",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Rebases local commits onto remote changes. Local history is rewritten and unrecoverable until pushed.",
    argsSchema: z.object({ cwd: z.string().optional() }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { cwd } = (args ?? {}) as { cwd?: string };
      const resolvedCwd = cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      // Palette, keybinding, and the terminal push-error recovery banner reach
      // run() ungated, so enforce the rebase confirm here (#8242). The ReviewHub
      // CTA calls the IPC directly and is gated by its own in-component dialog,
      // so it never goes through this action path. Agent dispatch is skipped for
      // the same reason as `git.push`: ActionService already cleared it against
      // the MCP bridge's own confirm, and this deferred store can only be
      // resolved by a renderer dialog a headless client cannot reach (#11538).
      if (ctx.dispatchSource !== "agent") {
        const confirmed = await useGitPullRebaseConfirmStore
          .getState()
          .requestConfirmation(resolvedCwd);
        if (!confirmed) return;
      }
      await window.electron.git.pullRebase(resolvedCwd);
    },
  }));

  actions.set("git.markSafeDirectory", () => ({
    id: "git.markSafeDirectory",
    title: "Trust Repository",
    description: "Mark a repository directory as safe for git operations",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ path: z.string().optional(), cwd: z.string().optional() }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const merged = (args ?? {}) as { path?: string; cwd?: string };
      const resolvedPath = merged.path ?? merged.cwd ?? ctx.activeWorktreePath;
      if (!resolvedPath) throw new Error("No active worktree");
      await window.electron.git.markSafeDirectory(resolvedPath);
    },
  }));

  actions.set("git.getStagingStatus", () => ({
    id: "git.getStagingStatus",
    title: "Get Staging Status",
    description:
      "Get the current working-tree state for a repository. Args: `cwd` (optional) — repo working directory, defaults to the active worktree path. Returns staged/unstaged file lists, conflicted/conflictedFiles, currentBranch, isDetachedHead, hasRemote, repoState, and rebase progress fields. Errors when `cwd` is omitted and no worktree is active. Use this before committing; do NOT use `git.getProjectPulse` for current changes — that reports historical activity, not working-tree state.",
    category: "git",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ cwd: z.string().optional() }).optional(),
    resultSchema: z.object({
      staged: z.array(z.unknown()),
      unstaged: z.array(z.unknown()),
      conflicted: z.array(z.string()),
      conflictedFiles: z.array(z.unknown()),
      isDetachedHead: z.boolean(),
      currentBranch: z.string().nullable(),
      hasRemote: z.boolean(),
      repoState: z.string(),
      rebaseStep: z.number().nullable(),
      rebaseTotalSteps: z.number().nullable(),
      rebaseSequence: z.unknown().nullable(),
    }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { cwd } = (args ?? {}) as { cwd?: string };
      const resolvedCwd = cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      return await window.electron.git.getStagingStatus(resolvedCwd);
    },
  }));
}
