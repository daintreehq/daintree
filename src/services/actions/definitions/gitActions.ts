import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import {
  ConflictedFileEntrySchema,
  GitStatusSchema,
  PaginatedResultSchema,
  PulseRangeDaysSchema,
  StagingFileEntrySchema,
  decodeIndexCursor,
} from "./schemas";
import {
  withWorktreeLocation,
  requireWorktreeId,
  requireWorktreePath,
  type WorktreeLocationArgs,
} from "./locationArgs";
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
      "Summarise a worktree's historical git activity — a commit heatmap, counts over a window, and the current streak. Use this for trends and momentum, not for what is changed right now: read the staging status for the current working tree. Widening the window or asking for the delta against the main branch costs more history to walk, so request those only when needed.",
    category: "git",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation({
      rangeDays: PulseRangeDaysSchema,
      includeDelta: z.boolean().optional(),
      includeRecentCommits: z.boolean().optional(),
      forceRefresh: z.boolean().optional(),
    }).optional(),
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
      const merged = (args ?? {}) as WorktreeLocationArgs & {
        rangeDays?: 60 | 120 | 180;
        includeDelta?: boolean;
        includeRecentCommits?: boolean;
        forceRefresh?: boolean;
      };
      const resolvedWorktreeId = requireWorktreeId(merged, ctx);
      const rangeDays = merged.rangeDays ?? 60;
      const pulse = await window.electron.git.getProjectPulse({
        ...merged,
        worktreeId: resolvedWorktreeId,
        rangeDays,
      } as any);

      // Hand-projected rather than spread: dispatch parses against `resultSchema`
      // now (#11539), but building the object explicitly keeps an added upstream
      // field from depending on that parse to stay unannounced. The
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
      "Read one file's git diff as a byte-bounded window, so a large diff cannot flood the response. When the result is flagged truncated, call again from the offset it hands back to continue — a single call is not guaranteed to be the whole diff. Some files have no diff text at all: binary files, unchanged files and oversized files come back as a marker instead, which is a valid result rather than a failure.",
    category: "git",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation(
      {
        filePath: z
          .string()
          .describe(
            "Identifies the file, as a repo-relative path taken from a working-tree status entry."
          ),
        status: GitStatusSchema.describe(
          "The file's git status, taken from the same working-tree status entry as its path. It selects which diff is computed, so a status that does not match the file yields the wrong comparison rather than an error."
        ),
        ignoreWhitespace: z
          .boolean()
          .optional()
          .describe("When true, whitespace-only changes are omitted from the diff."),
        // A BYTE offset into the diff text, not a list position — this action
        // windows one file's diff rather than paging a collection, so it stays
        // outside the shared `paginationShape` vocabulary.
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Byte offset to start reading from — pass a previous `nextOffset` (default 0)."
          ),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(GIT_FILE_DIFF_MAX_BYTES)
          .optional()
          .describe(
            `Maximum bytes to return (default ${GIT_FILE_DIFF_DEFAULT_MAX_BYTES}, max ${GIT_FILE_DIFF_MAX_BYTES}).`
          ),
      },
      { legacy: ["cwd"] }
    ),
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
      const { filePath, status, ignoreWhitespace, offset, maxBytes, ...location } =
        args as WorktreeLocationArgs & {
          filePath: string;
          status: z.infer<typeof GitStatusSchema>;
          ignoreWhitespace?: boolean;
          offset?: number;
          maxBytes?: number;
        };
      const resolvedCwd = requireWorktreePath(location, ctx);
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
      "List a repository's commit history, oldest changes last, with optional filtering by message, author or branch. Use this for history; read the staging status for uncommitted work. Commit bodies are cut off at roughly a kilobyte and flagged when that happens, so treat a truncated body as partial. Page onward with the cursor it returns while more results remain.",
    category: "git",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation(
      {
        search: z.string().optional(),
        branch: z.string().optional(),
      },
      {
        legacy: ["cwd"],
        pagination: { legacy: ["skip"], cursor: true, maxLimit: GIT_LIST_COMMITS_LIMIT_MAX },
      }
    ).optional(),
    resultSchema: PaginatedResultSchema(
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
    mcpOutputSchema: true,
    run: async (args: unknown, ctx: ActionContext) => {
      const {
        offset,
        cursor,
        limit: rawLimit,
        worktreeId,
        worktreePath,
        cwd,
        ...filters
      } = (args ?? {}) as WorktreeLocationArgs & {
        search?: string;
        branch?: string;
        offset?: number;
        cursor?: string;
        limit?: number;
      };
      const resolvedCwd = requireWorktreePath({ worktreeId, worktreePath, cwd }, ctx);
      // This source pages by index, so its cursor IS the next offset — an
      // explicit `offset`/`skip` still wins for callers that page by hand.
      const start = offset ?? decodeIndexCursor(cursor);
      // Clamped here as well as in argsSchema: dispatch paths that bypass schema
      // validation must not be able to request an unbounded page.
      const skip = Math.max(Math.trunc(start ?? 0) || 0, 0);
      const limit = clamp(
        rawLimit ?? GIT_LIST_COMMITS_LIMIT_DEFAULT,
        1,
        GIT_LIST_COMMITS_LIMIT_MAX
      );
      const result = await window.electron.git.listCommits({
        ...filters,
        cwd: resolvedCwd,
        skip,
        limit,
      } as any);

      // Bounded at limit + 1, not limit: a hash-prefix search pins its match
      // ahead of a full page of message matches, so cutting to `limit` would
      // drop the page's last message commit — which the next cursor then steps
      // over, making it unreachable on every page. This keeps paging exact
      // whenever the pinned commit is absent from the message stream; a pin that
      // also matches the search text is a pre-existing gap in `listCommits`
      // itself, which computes `hasMore` after removing the pin and dedupes only
      // on the first page.
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
        hasMore: result.hasMore ?? false,
        // The cursor is the next offset into the message stream, which advances
        // by exactly `limit` whenever hasMore is set — never by the returned
        // item count, which the pinned hash match can inflate.
        nextCursor: result.hasMore ? String(skip + limit) : null,
        total: result.total,
      };
    },
  }));

  actions.set("git.stageFile", () => ({
    id: "git.stageFile",
    title: "Stage File",
    description:
      "Stage one file's changes for the next commit. Reversible by unstaging, and staging an already-staged file is harmless. This changes the index only — nothing is committed or pushed until you do so explicitly.",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation({ filePath: z.string() }, { legacy: ["cwd"] }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { filePath, ...location } = args as WorktreeLocationArgs & { filePath: string };
      await window.electron.git.stageFile(requireWorktreePath(location, ctx), filePath);
    },
  }));

  actions.set("git.unstageFile", () => ({
    id: "git.unstageFile",
    title: "Unstage File",
    description:
      "Remove one file from the staging area, leaving its working-tree changes untouched. This is the inverse of staging and discards no edits.",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation({ filePath: z.string() }, { legacy: ["cwd"] }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { filePath, ...location } = args as WorktreeLocationArgs & { filePath: string };
      await window.electron.git.unstageFile(requireWorktreePath(location, ctx), filePath);
    },
  }));

  actions.set("git.stageAll", () => ({
    id: "git.stageAll",
    title: "Stage All Files",
    description:
      "Stage every modified and untracked file in the worktree for the next commit. This is broader than it looks — it sweeps in unrelated edits and new files — so read the staging status first when the commit is meant to be scoped. Reversible by unstaging everything.",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation({}, { legacy: ["cwd"] }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      await window.electron.git.stageAll(
        requireWorktreePath(args as WorktreeLocationArgs | undefined, ctx)
      );
    },
  }));

  actions.set("git.unstageAll", () => ({
    id: "git.unstageAll",
    title: "Unstage All Files",
    description:
      "Clear the staging area entirely, leaving all working-tree changes untouched. This is the inverse of staging everything and discards no edits.",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation({}, { legacy: ["cwd"] }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      await window.electron.git.unstageAll(
        requireWorktreePath(args as WorktreeLocationArgs | undefined, ctx)
      );
    },
  }));

  actions.set("git.commit", () => ({
    id: "git.commit",
    title: "Commit",
    description:
      "Commit whatever is currently staged, with a message. Read the staging status first — this commits the index as it stands, including anything staged earlier that you did not intend. The commit stays local until it is pushed, so it is recoverable, but rewriting it afterwards is not something this surface offers.",
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
    argsSchema: withWorktreeLocation(
      { message: z.string().min(1).optional() },
      { legacy: ["cwd"] }
    ).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { message, ...location } = (args ?? {}) as WorktreeLocationArgs & { message?: string };
      const resolvedCwd = requireWorktreePath(location, ctx);
      const trimmed = message?.trim();
      if (!trimmed) throw new Error("Commit message is required");
      return await window.electron.git.commit(resolvedCwd, trimmed);
    },
  }));

  actions.set("git.push", () => ({
    id: "git.push",
    title: "Push",
    description:
      "Publish local commits to the remote branch, making them visible to everyone working from it. This leaves the local repository and cannot be undone from here — confirm the commits are the intended ones first. It fails rather than overwriting when the remote has diverged.",
    category: "git",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale: "Pushes local commits to the remote. Recovery requires a force-push to undo.",
    argsSchema: withWorktreeLocation(
      { setUpstream: z.boolean().optional() },
      { legacy: ["cwd"] }
    ).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const { setUpstream, ...location } = (args ?? {}) as WorktreeLocationArgs & {
        setUpstream?: boolean;
      };
      const resolvedCwd = requireWorktreePath(location, ctx);
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
    argsSchema: withWorktreeLocation({}, { legacy: ["cwd"] }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const resolvedCwd = requireWorktreePath(args as WorktreeLocationArgs | undefined, ctx);
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
    argsSchema: withWorktreeLocation({}, { legacy: ["path", "cwd"] }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      await window.electron.git.markSafeDirectory(
        requireWorktreePath(args as WorktreeLocationArgs | undefined, ctx)
      );
    },
  }));

  actions.set("git.getStagingStatus", () => ({
    id: "git.getStagingStatus",
    title: "Get Staging Status",
    description:
      "Read the current working-tree state of a repository: what is staged, what is modified but unstaged, what is conflicted, and which branch is checked out. Read this before committing. Use the activity pulse for historical trends instead — it reports past activity, not current changes. Long file lists are paged, so a partial page is normal; continue from the offset it hands back while more remain.",
    category: "git",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    // `offset`/`limit` are declared inline rather than through `paginationShape`:
    // they are already the canonical spellings, and one page position is applied
    // to THREE independent file lists, so the shared per-list descriptions and
    // the single-list `PaginatedResultSchema` envelope would both misdescribe it.
    argsSchema: withWorktreeLocation(
      {
        offset: z.number().int().nonnegative().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(GIT_PAGE_LIMIT_MAX)
          .optional()
          .describe(
            `Entries per file list (default ${GIT_PAGE_LIMIT_DEFAULT}, max ${GIT_PAGE_LIMIT_MAX}).`
          ),
      },
      { legacy: ["cwd"] }
    ).optional(),
    resultSchema: z.object({
      staged: z.array(StagingFileEntrySchema),
      unstaged: z.array(StagingFileEntrySchema),
      conflicted: z.array(z.string()),
      conflictedFiles: z.array(ConflictedFileEntrySchema),
      totals: z.object({ staged: z.number(), unstaged: z.number(), conflictedFiles: z.number() }),
      hasMore: z.object({
        staged: z.boolean(),
        unstaged: z.boolean(),
        conflictedFiles: z.boolean(),
      }),
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
        offset: rawOffset,
        limit: rawLimit,
        ...location
      } = (args ?? {}) as WorktreeLocationArgs & { offset?: number; limit?: number };
      const resolvedCwd = requireWorktreePath(location, ctx);
      // Clamped here as well as in argsSchema: dispatch paths that bypass schema
      // validation must not be able to request an unbounded page.
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
        nextOffset: staged.nextOffset ?? unstaged.nextOffset ?? conflictedFiles.nextOffset ?? null,
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
