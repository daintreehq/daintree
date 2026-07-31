import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import {
  ConflictedFileEntrySchema,
  GitStatusSchema,
  PulseRangeDaysSchema,
  StagingFileEntrySchema,
} from "./schemas";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import { paginate, truncateUtf8 } from "@shared/utils/boundedOutput";
import {
  GIT_COMMIT_BODY_MAX_BYTES,
  GIT_FILE_DIFF_DEFAULT_MAX_BYTES,
  GIT_FILE_DIFF_MAX_BYTES,
  GIT_LIST_COMMITS_LIMIT_DEFAULT,
  GIT_LIST_COMMITS_LIMIT_MAX,
  GIT_PAGE_LIMIT_DEFAULT,
  GIT_PAGE_LIMIT_MAX,
  GIT_SUBJECT_MAX_BYTES,
  PULSE_RECENT_COMMITS_MAX,
} from "@shared/config/gitReadLimits";
import type { ConflictedFileEntry, StagingFileEntry } from "@shared/types/git";
import type { CommitItem, HeatCell } from "@shared/types/pulse";
import { z } from "zod";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.trunc(value) || min, min), max);

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
      heatmap: z.array(
        z.object({
          date: z.string(),
          count: z.number(),
          level: z.number(),
          isToday: z.boolean().optional(),
          isMostRecentActive: z.boolean().optional(),
          isBeforeProject: z.boolean().optional(),
        })
      ),
      commitsInRange: z.number(),
      activeDays: z.number(),
      projectAgeDays: z.number(),
      currentStreakDays: z.number().optional(),
      recentCommits: z.array(
        z.object({
          sha: z.string(),
          subject: z.string(),
          authorName: z.string().optional(),
          timestamp: z.number(),
        })
      ),
      uncommitted: z
        .object({
          changedFiles: z.number(),
          insertions: z.number().optional(),
          deletions: z.number().optional(),
          lastUpdated: z.number().optional(),
        })
        .optional(),
      deltaToMain: z
        .object({
          baseBranch: z.string(),
          headBranch: z.string().optional(),
          ahead: z.number(),
          behind: z.number(),
          filesChanged: z.number().optional(),
          insertions: z.number().optional(),
          deletions: z.number().optional(),
        })
        .optional(),
    }),
    mcpOutputSchema: true,
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
      const rangeDays = merged.rangeDays ?? 60;
      const pulse = await window.electron.git.getProjectPulse({
        ...merged,
        worktreeId: resolvedWorktreeId,
        rangeDays,
      } as any);

      // Hand-projected rather than spread: `resultSchema` never runs, so an
      // added upstream field would otherwise ship to agents unannounced. The
      // heatmap stays whole — it is what the renderer pulse card charts, and
      // `rangeDays` (<= 180) already bounds it.
      return {
        worktreeId: pulse.worktreeId,
        worktreePath: pulse.worktreePath,
        branch: pulse.branch,
        mainBranch: pulse.mainBranch,
        rangeDays: pulse.rangeDays,
        generatedAt: pulse.generatedAt,
        heatmap: (pulse.heatmap ?? []).slice(-rangeDays).map((cell: HeatCell) => ({
          date: cell.date,
          count: cell.count,
          level: cell.level,
          isToday: cell.isToday,
          isMostRecentActive: cell.isMostRecentActive,
          isBeforeProject: cell.isBeforeProject,
        })),
        commitsInRange: pulse.commitsInRange,
        activeDays: pulse.activeDays,
        projectAgeDays: pulse.projectAgeDays,
        currentStreakDays: pulse.currentStreakDays,
        recentCommits: (pulse.recentCommits ?? [])
          .slice(0, PULSE_RECENT_COMMITS_MAX)
          .map((commit: CommitItem) => ({
            sha: commit.sha,
            subject: truncateUtf8(commit.subject ?? "", GIT_SUBJECT_MAX_BYTES).text,
            authorName:
              commit.authorName === undefined
                ? undefined
                : truncateUtf8(commit.authorName, GIT_SUBJECT_MAX_BYTES).text,
            timestamp: commit.timestamp,
          })),
        uncommitted: pulse.uncommitted && {
          changedFiles: pulse.uncommitted.changedFiles,
          insertions: pulse.uncommitted.insertions,
          deletions: pulse.uncommitted.deletions,
          lastUpdated: pulse.uncommitted.lastUpdated,
        },
        deltaToMain: pulse.deltaToMain && {
          baseBranch: pulse.deltaToMain.baseBranch,
          headBranch: pulse.deltaToMain.headBranch,
          ahead: pulse.deltaToMain.ahead,
          behind: pulse.deltaToMain.behind,
          filesChanged: pulse.deltaToMain.filesChanged,
          // PulseSummary renders these; dropping them blanks the +/- churn.
          insertions: pulse.deltaToMain.insertions,
          deletions: pulse.deltaToMain.deletions,
        },
      };
    },
  }));

  actions.set("git.getFileDiff", () => ({
    id: "git.getFileDiff",
    title: "Get File Diff",
    description:
      "Get a byte-bounded window of the git diff for a single file. Args: `cwd` (optional) — repo working directory, defaults to the active worktree path; `filePath` (required) — repo-relative path; `status` (required) — the file's git status (from a `git.getStagingStatus` entry); `ignoreWhitespace` (optional); `offset` (optional, default 0) — byte offset to read from; `maxBytes` (optional, default 24576, max 1048576) — window size. Returns { content, offset, totalBytes, truncated, nextOffset }. When `truncated` is true, call again with `offset: nextOffset` to read the rest. `content` may be a `BINARY_FILE` or `NO_CHANGES` marker instead of diff text, in which case `totalBytes` is 0. Errors when `cwd` is omitted and no worktree is active.",
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
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Byte offset to start reading from — pass a previous `nextOffset` (default 0)."),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(GIT_FILE_DIFF_MAX_BYTES)
        .optional()
        .describe(
          `Maximum bytes to return (default ${GIT_FILE_DIFF_DEFAULT_MAX_BYTES}, max ${GIT_FILE_DIFF_MAX_BYTES}).`
        ),
    }),
    examples: [
      {
        args: { filePath: "src/index.css", status: "modified" },
        description: "Get the first 24KB of the diff for a modified file",
      },
      {
        args: { filePath: "package-lock.json", status: "modified", offset: 24576 },
        description: "Continue reading a large diff from a previous `nextOffset`",
      },
    ],
    resultSchema: z.object({
      content: z.string(),
      offset: z.number(),
      totalBytes: z.number(),
      truncated: z.boolean(),
      nextOffset: z.number().nullable(),
    }),
    mcpOutputSchema: true,
    run: async (args: unknown, ctx: ActionContext) => {
      const { cwd, filePath, status, ignoreWhitespace, offset, maxBytes } = args as {
        cwd?: string;
        filePath: string;
        status: z.infer<typeof GitStatusSchema>;
        ignoreWhitespace?: boolean;
        offset?: number;
        maxBytes?: number;
      };
      const resolvedCwd = cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      // Clamped here as well as in argsSchema: dispatch paths that bypass
      // schema validation must not be able to request an unbounded window.
      const result = await window.electron.git.getFileDiff(
        resolvedCwd,
        filePath,
        status as any,
        ignoreWhitespace,
        {
          offset: Math.max(Math.trunc(offset ?? 0) || 0, 0),
          maxBytes: clamp(maxBytes ?? GIT_FILE_DIFF_DEFAULT_MAX_BYTES, 1, GIT_FILE_DIFF_MAX_BYTES),
        }
      );
      return {
        content: result.content,
        offset: result.offset,
        totalBytes: result.totalBytes,
        truncated: result.truncated,
        nextOffset: result.nextOffset,
      };
    },
  }));

  actions.set("git.listCommits", () => ({
    id: "git.listCommits",
    title: "List Commits",
    description:
      "List commits for a repository with optional search and pagination. Args (all optional): `cwd` (repo dir, defaults to the active worktree path); `search` (message/author filter); `branch`; `skip`; `limit` (default 30, max 100). Returns { items, hasMore, total, skip, limit, nextSkip } — each item has hash, shortHash, message, body, bodyTruncated, author {name,email}, date. Commit bodies are cut at 1KB and flagged with `bodyTruncated: true`. When `hasMore` is true, call again with `skip: nextSkip`. Errors when `cwd` is omitted and no worktree is active.",
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
        limit: z
          .number()
          .int()
          .positive()
          .max(GIT_LIST_COMMITS_LIMIT_MAX)
          .optional()
          .describe(
            `Commits per page (default ${GIT_LIST_COMMITS_LIMIT_DEFAULT}, max ${GIT_LIST_COMMITS_LIMIT_MAX}).`
          ),
      })
      .optional(),
    resultSchema: z.object({
      items: z.array(
        z.object({
          hash: z.string(),
          shortHash: z.string(),
          message: z.string(),
          body: z.string().optional(),
          bodyTruncated: z.boolean(),
          author: z.object({ name: z.string(), email: z.string() }),
          date: z.string(),
        })
      ),
      hasMore: z.boolean(),
      total: z.number(),
      skip: z.number(),
      limit: z.number(),
      nextSkip: z.number().nullable(),
    }),
    mcpOutputSchema: true,
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
      const skip = Math.max(Math.trunc(merged.skip ?? 0) || 0, 0);
      const limit = clamp(
        merged.limit ?? GIT_LIST_COMMITS_LIMIT_DEFAULT,
        1,
        GIT_LIST_COMMITS_LIMIT_MAX
      );
      const result = await window.electron.git.listCommits({
        ...merged,
        cwd: resolvedCwd,
        skip,
        limit,
      } as any);

      // Bounded at limit + 1, not limit: a hash-prefix search pins its match
      // ahead of a full page of message matches, so cutting to `limit` would
      // drop the page's last message commit — which `nextSkip` then steps over,
      // making it unreachable on every page.
      const items = (result.items ?? []).slice(0, limit + 1).map((commit) => {
        const body = truncateUtf8(commit.body ?? "", GIT_COMMIT_BODY_MAX_BYTES);
        return {
          hash: commit.hash,
          shortHash: commit.shortHash,
          message: truncateUtf8(commit.message ?? "", GIT_SUBJECT_MAX_BYTES).text,
          body: commit.body === undefined ? undefined : body.text,
          bodyTruncated: body.truncated,
          // Author identity is attacker-controlled free text in a crafted
          // commit, so it needs the same ceiling as the subject and body.
          author: {
            name: truncateUtf8(commit.author?.name ?? "", GIT_SUBJECT_MAX_BYTES).text,
            email: truncateUtf8(commit.author?.email ?? "", GIT_SUBJECT_MAX_BYTES).text,
          },
          date: commit.date,
        };
      });

      return {
        items,
        hasMore: result.hasMore,
        total: result.total,
        skip,
        limit,
        // `skip` addresses the message stream, which advances by exactly `limit`
        // whenever hasMore is set — never by the returned item count, which the
        // pinned hash match can inflate.
        nextSkip: result.hasMore ? skip + limit : null,
      };
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
      "Get the current working-tree state for a repository. Args (all optional): `cwd` — repo working directory, defaults to the active worktree path; `offset` (default 0) and `limit` (default 100, max 200), applied to each file list. Returns staged/unstaged/conflictedFiles pages plus `totals` and `hasMore` per list, the legacy `conflicted` path strings, currentBranch, isDetachedHead, hasRemote, repoState, rebase progress, and `rebaseSummary` (backend + step counts + current subject) instead of the full rebase todo. When any `hasMore` is true, call again with `offset: nextOffset`. Errors when `cwd` is omitted and no worktree is active. Use this before committing; do NOT use `git.getProjectPulse` for current changes — that reports historical activity, not working-tree state.",
    category: "git",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        cwd: z.string().optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(GIT_PAGE_LIMIT_MAX)
          .optional()
          .describe(`Entries per file list (default ${GIT_PAGE_LIMIT_DEFAULT}, max ${GIT_PAGE_LIMIT_MAX}).`),
      })
      .optional(),
    resultSchema: z.object({
      staged: z.array(StagingFileEntrySchema),
      unstaged: z.array(StagingFileEntrySchema),
      conflicted: z.array(z.string()),
      conflictedFiles: z.array(ConflictedFileEntrySchema),
      totals: z.object({ staged: z.number(), unstaged: z.number(), conflictedFiles: z.number() }),
      hasMore: z.object({ staged: z.boolean(), unstaged: z.boolean(), conflictedFiles: z.boolean() }),
      offset: z.number(),
      limit: z.number(),
      nextOffset: z.number().nullable(),
      isDetachedHead: z.boolean(),
      currentBranch: z.string().nullable(),
      hasRemote: z.boolean(),
      repoState: z.string(),
      rebaseStep: z.number().nullable(),
      rebaseTotalSteps: z.number().nullable(),
      rebaseSummary: z
        .object({
          backend: z.string(),
          totalEntries: z.number(),
          completedEntries: z.number(),
          pendingEntries: z.number(),
          currentSubject: z.string().nullable(),
        })
        .nullable(),
    }),
    mcpOutputSchema: true,
    run: async (args: unknown, ctx: ActionContext) => {
      const {
        cwd,
        offset: rawOffset,
        limit: rawLimit,
      } = (args ?? {}) as { cwd?: string; offset?: number; limit?: number };
      const resolvedCwd = cwd ?? ctx.activeWorktreePath;
      if (!resolvedCwd) throw new Error("No active worktree");
      const offset = Math.max(Math.trunc(rawOffset ?? 0) || 0, 0);
      const limit = clamp(rawLimit ?? GIT_PAGE_LIMIT_DEFAULT, 1, GIT_PAGE_LIMIT_MAX);
      const status = await window.electron.git.getStagingStatus(resolvedCwd);

      const projectFile = (entry: StagingFileEntry) => ({
        path: entry.path,
        status: entry.status,
        insertions: entry.insertions ?? null,
        deletions: entry.deletions ?? null,
      });

      const staged = paginate(status.staged ?? [], offset, limit);
      const unstaged = paginate(status.unstaged ?? [], offset, limit);
      const conflictedFiles = paginate(status.conflictedFiles ?? [], offset, limit);

      const sequence = status.rebaseSequence;
      const entries = sequence?.entries ?? [];
      const current = entries.find((entry) => entry.state === "current") ?? null;

      return {
        staged: staged.items.map(projectFile),
        unstaged: unstaged.items.map(projectFile),
        // Derived from the paged entries so the deprecated string list can
        // never disagree with `conflictedFiles` inside one response.
        conflicted: conflictedFiles.items.map((entry: ConflictedFileEntry) => entry.path),
        conflictedFiles: conflictedFiles.items.map((entry: ConflictedFileEntry) => ({
          path: entry.path,
          xy: entry.xy,
          label: entry.label,
        })),
        totals: {
          staged: staged.total,
          unstaged: unstaged.total,
          conflictedFiles: conflictedFiles.total,
        },
        hasMore: {
          staged: staged.hasMore,
          unstaged: unstaged.hasMore,
          conflictedFiles: conflictedFiles.hasMore,
        },
        offset,
        limit,
        nextOffset:
          staged.nextOffset ?? unstaged.nextOffset ?? conflictedFiles.nextOffset ?? null,
        isDetachedHead: status.isDetachedHead,
        currentBranch: status.currentBranch,
        hasRemote: status.hasRemote,
        repoState: status.repoState,
        rebaseStep: status.rebaseStep,
        rebaseTotalSteps: status.rebaseTotalSteps,
        // Summarized, not forwarded: the raw sequence carries one entry per
        // commit in the rebase, which is unbounded in a long replay.
        rebaseSummary: sequence
          ? {
              backend: sequence.backend,
              totalEntries: entries.length,
              completedEntries: entries.filter((entry) => entry.state === "done").length,
              pendingEntries: entries.filter((entry) => entry.state === "pending").length,
              currentSubject: current
                ? truncateUtf8(current.subject ?? "", GIT_SUBJECT_MAX_BYTES).text
                : null,
            }
          : null,
      };
    },
  }));
}
