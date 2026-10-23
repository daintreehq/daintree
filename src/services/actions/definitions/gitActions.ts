import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import {
  ConflictedFileEntrySchema,
  GitStatusSchema,
  PaginatedResultSchema,
  PulseRangeDaysSchema,
  StagingFileEntrySchema,
} from "./schemas";
import { withWorktreeLocation } from "./locationArgs";
import {
  GIT_FILE_DIFF_DEFAULT_MAX_BYTES,
  GIT_FILE_DIFF_MAX_BYTES,
  GIT_LIST_COMMITS_LIMIT_MAX,
  GIT_PAGE_LIMIT_DEFAULT,
  GIT_PAGE_LIMIT_MAX,
} from "@shared/config/gitReadLimits";
import { z } from "zod";
import { fileMutationArgsSchema } from "./gitActionArgs";
import type { GitActionRunId } from "./gitActions.impl";

/**
 * A base branch as an action argument.
 *
 * Not a free-form string: it reaches a git invocation, and the worktree
 * snapshot is the only place a legitimate caller gets it from. The main-process
 * handler validates it again — this is the layer that keeps a malformed value
 * from being dispatched at all, not the one the safety rests on.
 */
const BaseBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .describe("The base branch to integrate, as named on the worktree's snapshot.");

const RepoOperationStateSchema = z
  .enum(["MERGING", "REBASING", "CHERRY_PICKING", "REVERTING"])
  .optional()
  .describe("Which operation is in progress, used only to label the confirm while it loads.");

/**
 * Run bodies load on first dispatch (#14239). Every view registers the git
 * actions at boot for menus, keybindings and the MCP manifest, but an empty
 * view runs none of them. A failed chunk load rejects inside `run`, which
 * ActionService turns into an error result like any other failure.
 */
async function runGitAction(
  id: GitActionRunId,
  args: unknown,
  ctx: ActionContext
): Promise<unknown> {
  const { gitActionRuns } = await import("./gitActions.impl");
  return gitActionRuns[id](args, ctx);
}

export function registerGitActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("git.getProjectPulse", () => ({
    id: "git.getProjectPulse",
    title: "Get project pulse",
    description:
      "Summarise a worktree's git history: commit heatmap, counts over a window, current streak. For trends, not current changes. A wider window or the delta against main walks more history, so ask only when needed.",
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
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.getProjectPulse", args, ctx),
  }));

  actions.set("git.getFileDiff", () => ({
    id: "git.getFileDiff",
    title: "Get file diff",
    description:
      "Read one file's git diff as a byte-bounded window, so a large diff cannot flood the response. When the result is flagged truncated, call again from the offset it hands back to continue: a single call is not guaranteed to be the whole diff. Some files have no diff text at all, and binary, unchanged and oversized files come back as a marker instead, which is a valid result rather than a failure.",
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
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.getFileDiff", args, ctx),
  }));

  actions.set("git.listCommits", () => ({
    id: "git.listCommits",
    title: "List commits",
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
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.listCommits", args, ctx),
  }));

  actions.set("git.stageFile", () => ({
    id: "git.stageFile",
    title: "Stage file",
    description:
      "Stage one file's changes for the next commit. Reversible by unstaging, and staging an already-staged file is harmless. This changes the index only — nothing is committed or pushed until you do so explicitly.",
    category: "git",
    kind: "command",
    // Deliberately unattended at system tier (#12118): the index is the only
    // thing written, `git.unstageFile` is the exact inverse, and no
    // working-tree content can be lost. A confirm on every staging call would
    // buy fatigue rather than safety.
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation({ filePath: z.string() }, { legacy: ["cwd"] }),
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.stageFile", args, ctx),
  }));

  actions.set("git.unstageFile", () => ({
    id: "git.unstageFile",
    title: "Unstage file",
    description:
      "Remove one file from the staging area, leaving its working-tree changes untouched. This is the inverse of staging and discards no edits.",
    category: "git",
    kind: "command",
    // Deliberately unattended at system tier (#12118): the inverse of staging,
    // and it discards no edits.
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation({ filePath: z.string() }, { legacy: ["cwd"] }),
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.unstageFile", args, ctx),
  }));

  actions.set("git.discardFileChanges", () => ({
    id: "git.discardFileChanges",
    title: "Discard file changes",
    description:
      "Put one changed file back to its last commit, dropping both its staged and unstaged changes. A file new since that commit, or a rename's new copy, moves to the OS Trash instead. Untracked and conflicted files are refused.",
    category: "git",
    kind: "command",
    // D1 (#13424): a working-tree edit restored over has no copy anywhere —
    // not in the reflog, not in the Trash.
    danger: "confirm",
    dangerRationale:
      "Overwrites the file with its committed version. Its uncommitted edits are lost and git cannot recover them.",
    scope: "renderer",
    argsSchema: fileMutationArgsSchema,
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.discardFileChanges", args, ctx),
  }));

  actions.set("git.stageAll", () => ({
    id: "git.stageAll",
    title: "Stage all files",
    description:
      "Stage every change in the worktree for the next commit — modifications, new files, deletions and renames alike. This is broader than it looks — it sweeps in unrelated edits — so read the staging status first when the commit is meant to be scoped. Reversible by unstaging everything.",
    category: "git",
    kind: "command",
    // Deliberately unattended at system tier (#12118) despite the wider reach:
    // no working-tree content can be lost, and the staging can be redone. Note
    // the inverse is not exact — `git.unstageAll` resets the index to HEAD, so
    // a partial selection staged earlier (`git add -p` in a terminal) is not
    // restored by it. What that costs is the selection, never the edits.
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation({}, { legacy: ["cwd"] }).optional(),
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.stageAll", args, ctx),
  }));

  actions.set("git.unstageAll", () => ({
    id: "git.unstageAll",
    title: "Unstage all files",
    description:
      "Clear the staging area entirely, leaving all working-tree changes untouched. This is the inverse of staging everything and discards no edits.",
    category: "git",
    kind: "command",
    // Deliberately unattended at system tier (#12118): clears the index only.
    // Every working-tree edit survives and the staging can be redone.
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation({}, { legacy: ["cwd"] }).optional(),
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.unstageAll", args, ctx),
  }));

  actions.set("git.commit", () => ({
    id: "git.commit",
    title: "Commit",
    description:
      "Commit whatever is currently staged, with a message. Read the staging status first — this commits the index as it stands, including anything staged earlier that you did not intend. The commit stays local until it is pushed, so it is recoverable, but rewriting it afterwards is not something this surface offers.",
    category: "git",
    kind: "command",
    // Deliberately unattended at system tier (#12118): the commit stays local
    // and Git-recoverable until it is pushed, `run()` refuses without an
    // authored message, and `git.push` — the point at which the work becomes
    // shared — is the D2 gate, with its own branch and commit preview.
    danger: "safe",
    scope: "renderer",
    keywords: ["commit", "stage", "review", "changes"],
    // Headless/MCP tool: run() requires an authored commit `message` and throws
    // without one. Per the #7880 no-silent-fallback rule, a palette "Commit"
    // must never derive a message — redirect to the Review Hub, which shows the
    // staged files and requires the user to type the message before committing.
    palette: { mode: "redirect", to: "worktree.openReviewHub" },
    // `message` is REQUIRED in the schema because run() requires it. Declaring
    // it optional advertised `{}` as a valid call to every model reading the
    // manifest, and the only way to learn otherwise was to dispatch and be
    // thrown at. The wrapper stays non-optional for the same reason — an
    // omitted argument object can never satisfy the handler.
    argsSchema: withWorktreeLocation(
      {
        message: z
          .string()
          .trim()
          .min(1)
          .describe("Commit message. Required — nothing derives one for you."),
      },
      { legacy: ["cwd"] }
    ),
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.commit", args, ctx),
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
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.push", args, ctx),
  }));

  actions.set("git.pullRebase", () => ({
    id: "git.pullRebase",
    title: "Pull and rebase",
    description: "Pull remote changes and rebase local commits",
    category: "git",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Rebases local commits onto remote changes. Local history is rewritten and unrecoverable until pushed.",
    argsSchema: withWorktreeLocation({}, { legacy: ["cwd"] }).optional(),
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.pullRebase", args, ctx),
  }));

  actions.set("git.fetch", () => ({
    id: "git.fetch",
    title: "Fetch",
    description:
      "Update this worktree's remote-tracking refs so its ahead/behind counts match the remote. HEAD, the working tree, and local branches are left untouched.",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation(
      {
        prune: z
          .boolean()
          .optional()
          .describe("Also delete remote-tracking refs for branches gone from the remote."),
      },
      { legacy: ["cwd"] }
    ).optional(),
    // The context-menu rows dispatch this and drop the result on the floor, and
    // the palette's fallback toast is the only one ActionService has — so a
    // fetch that hit an auth wall from the menu would fail in total silence.
    // Own the toast here instead, and it reaches every surface.
    selfNotifiesOnExecutionError: true,
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.fetch", args, ctx),
  }));

  /**
   * Integrating the base branch into a worktree (#12092).
   *
   * Both take an explicit `baseBranch` rather than resolving one themselves.
   * The worktree card already knows it — `BaseDivergence` publishes it on the
   * snapshot as the branch the `↓N behind` count is measured against — and
   * re-deriving it here would let the menu row and the operation disagree about
   * which branch "base" means. The main-process handler resolves that name to a
   * *ref* through the same code the count uses, and refuses if it cannot.
   *
   * The confirm split mirrors `git.push` / `git.pullRebase` (#11538): palette,
   * keybinding and menu dispatch gate on the deferred-Promise store here,
   * because they reach `run()` ungated. Agent dispatch is skipped — ActionService
   * has already cleared it against the MCP bridge's own confirm, and this store
   * resolves only from a renderer dialog no headless client can click, so
   * re-requesting would hang the call forever.
   */
  actions.set("git.rebaseOntoBase", () => ({
    id: "git.rebaseOntoBase",
    title: "Rebase onto base branch",
    description: "Replay this worktree's commits on top of its base branch",
    category: "git",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Rewrites local history: every replayed commit gets a new hash, and a branch that is already pushed needs a force-push afterwards.",
    argsSchema: withWorktreeLocation({ baseBranch: BaseBranchSchema }, { legacy: ["cwd"] }),
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.rebaseOntoBase", args, ctx),
  }));

  actions.set("git.mergeBaseIntoBranch", () => ({
    id: "git.mergeBaseIntoBranch",
    title: "Merge base branch in",
    description: "Merge this worktree's base branch into its current branch",
    category: "git",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Extends local history with a merge commit. Existing commits keep their hashes, but the merge itself is only undone by resetting the branch.",
    argsSchema: withWorktreeLocation({ baseBranch: BaseBranchSchema }, { legacy: ["cwd"] }),
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.mergeBaseIntoBranch", args, ctx),
  }));

  /**
   * Recovery for a worktree left mid-operation (#12092).
   *
   * The IPC has existed since conflict handling shipped, but only Review Hub
   * called it — so a stranded worktree could only be recovered by first finding
   * the panel that owns the conflict. These wrap it so the recovery sits next to
   * the operation that strands the worktree.
   *
   * Abort confirms and Continue does not, and the asymmetry is the point: abort
   * discards conflict resolutions and replayed commits, while continue advances
   * an operation the user already started and can still abort afterwards.
   */
  actions.set("git.abortRepositoryOperation", () => ({
    id: "git.abortRepositoryOperation",
    title: "Abort Git operation",
    description: "Abort the merge, rebase, cherry-pick, or revert this worktree is halted on",
    category: "git",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Discards staged conflict resolutions and any commits already replayed, returning the worktree to its pre-operation state.",
    argsSchema: withWorktreeLocation({ operation: RepoOperationStateSchema }, { legacy: ["cwd"] }),
    run: (args: unknown, ctx: ActionContext) =>
      runGitAction("git.abortRepositoryOperation", args, ctx),
  }));

  actions.set("git.continueRepositoryOperation", () => ({
    id: "git.continueRepositoryOperation",
    title: "Continue Git operation",
    description: "Continue the merge, rebase, cherry-pick, or revert this worktree is halted on",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation({}, { legacy: ["cwd"] }).optional(),
    run: (args: unknown, ctx: ActionContext) =>
      runGitAction("git.continueRepositoryOperation", args, ctx),
  }));

  actions.set("git.forcePushWithLease", () => ({
    id: "git.forcePushWithLease",
    title: "Force push with lease",
    description:
      "Complete a rebase on a published branch by overwriting the remote with the local one, but only while the remote still matches the state a rejected push observed. Available only after a push has actually been rejected for a diverged remote — the lease it overwrites against is captured from that rejection and cannot be recomputed.",
    category: "git",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Rewrites a published branch. Remote commits the local branch does not contain are discarded and are recoverable only from a reflog on whoever pushed them.",
    // Hidden from the palette and from every headless surface for the same
    // reason: the action's real requirement — a lease captured moments earlier
    // by a rejected push — lives in `run()`, not in `argsSchema`. A palette
    // entry would be a row that fails on nearly every worktree, and an MCP
    // client has no way to have produced the rejection this reads.
    palette: { mode: "hidden" },
    mcpVisibility: "hidden",
    argsSchema: withWorktreeLocation({}, { legacy: ["cwd"] }).optional(),
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.forcePushWithLease", args, ctx),
  }));

  actions.set("git.markSafeDirectory", () => ({
    id: "git.markSafeDirectory",
    title: "Trust repository",
    description: "Mark a repository directory as safe for git operations",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation({}, { legacy: ["path", "cwd"] }).optional(),
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.markSafeDirectory", args, ctx),
  }));

  actions.set("git.retryAuthFetch", () => ({
    id: "git.retryAuthFetch",
    title: "Retry suspended fetches",
    description:
      "Lift the pause on background fetches that Git rejected for authentication and fetch every worktree again. Use after fixing the SSH key or Git credential helper.",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.retryAuthFetch", args, ctx),
  }));

  actions.set("git.getStagingStatus", () => ({
    id: "git.getStagingStatus",
    title: "Get staging status",
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
    run: (args: unknown, ctx: ActionContext) => runGitAction("git.getStagingStatus", args, ctx),
  }));
}
