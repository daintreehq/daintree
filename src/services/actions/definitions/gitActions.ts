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
import { useGitWorktreeOperationConfirmStore } from "@/store/gitWorktreeOperationConfirmStore";
import { isClientGitError } from "@/utils/clientGitError";
import { humanizeAppError, formatErrorMessage } from "@shared/utils/errorMessage";
import { notify } from "@/lib/notify";
import type { RepoOperationState } from "@/components/Git/repoOperationCopy";
import { actionService } from "@/services/ActionService";
import { worktreeClient } from "@/clients";
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
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { isClientGitError } from "@/utils/clientGitError";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.trunc(value) || min, min), max);

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

/** The parsed args of an action built with `withWorktreeLocation({ baseBranch })`. */
interface BaseIntegrationArgs extends WorktreeLocationArgs {
  baseBranch: string;
}

/**
 * Read a base-integration action's validated args.
 *
 * The cast is unavoidable — `run` receives `unknown` and the shape is only
 * knowable from the `argsSchema` a few lines above — but it is written ONCE
 * here rather than at each call site, so the assertion is reviewed once and the
 * two actions read a named type.
 */
function readBaseIntegrationArgs(args: unknown): BaseIntegrationArgs {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ActionService validated `argsSchema` before run()
  return (args ?? {}) as BaseIntegrationArgs;
}

/**
 * Re-read one worktree's state after a git operation touched it.
 *
 * Scoped to the worktree rather than the whole sidebar: a base integration
 * changes exactly one tree, and `worktree.refresh`'s no-arg form also refreshes
 * every pull request against the provider's rate limit.
 *
 * A worktree the renderer's index does not know is SKIPPED rather than
 * refreshed with `undefined` — that argument does not mean "no worktree", it
 * means "all of them", and quietly widening a one-worktree refresh into a
 * global topology-plus-PR sweep is the opposite of what this function claims to
 * do. Polling reconciles that tree on its own.
 */
async function refreshWorktree(
  location: WorktreeLocationArgs | undefined,
  ctx: ActionContext
): Promise<void> {
  const worktreeId = resolveWorktreeIdOrNull(location, ctx);
  if (!worktreeId) return;
  try {
    await worktreeClient.refresh(worktreeId);
  } catch {
    // Never turn a successful git mutation into a reported failure over a UI
    // read. Polling reconciles regardless.
  }
}

/** The worktree id for `location`, or `null` when the index cannot name one. */
function resolveWorktreeIdOrNull(
  location: WorktreeLocationArgs | undefined,
  ctx: ActionContext
): string | null {
  try {
    return requireWorktreeId(location, ctx);
  } catch {
    return null;
  }
}

/**
 * Take the user to the conflict UI when git stopped mid-operation.
 *
 * The worktree card cannot do this on its own. Its `repoState` badge is
 * deliberately passive — the interactive Continue/Abort row was removed in
 * #10921 because a second git process from the card collides with an operation
 * an agent is running in its own PTY — so a halt that only flipped the badge
 * would leave the user looking at the word "rebasing" with no way forward.
 * Review Hub's `ConflictPanel` is the takeover surface, and it renders for ANY
 * halted operation regardless of what started it.
 *
 * Reads the status fresh rather than trusting the snapshot: the halt happened
 * milliseconds ago and the polled snapshot has not seen it yet.
 *
 * Returns whether the conflict surface is actually now open. The caller uses
 * that to decide whether to swallow its error, so a dispatch that resolved
 * `{ok:false}` — Review Hub's own action fails softly when the worktree lookup
 * misses — must report `false` here. Reporting `true` on a panel that never
 * opened would turn a failed rebase into a silent success.
 */
async function routeHaltToReviewHub(
  cwd: string,
  location: WorktreeLocationArgs | undefined,
  ctx: ActionContext
): Promise<boolean> {
  let halted: boolean;
  try {
    const status = await window.electron.git.getStagingStatus(cwd);
    halted = status.repoState !== "CLEAN" && status.repoState !== "DIRTY";
  } catch {
    // If the status read fails we cannot claim a halt. The error the caller is
    // already handling stays the whole story.
    return false;
  }
  if (!halted) return false;

  const worktreeId = resolveWorktreeIdOrNull(location, ctx);
  if (!worktreeId) return false;
  // Inherits the source that got here, so a menu-initiated halt opens Review
  // Hub as a menu dispatch rather than laundering itself into a user one.
  const result = await actionService.dispatch(
    "worktree.openReviewHub",
    { worktreeId },
    ctx.dispatchSource ? { source: ctx.dispatchSource } : undefined
  );
  return result.ok;
}

/**
 * Run a base integration and make sure its outcome is visible.
 *
 * Refreshes on BOTH paths, not just success: a rebase that stops on a conflict
 * throws while having genuinely moved the worktree, so refreshing only on
 * success leaves the card claiming the pre-rebase state (#12092).
 *
 * The error is swallowed in exactly one case, and the narrowness is the point.
 * It must be a CONFLICT — read off the classified `gitReason` the handler
 * encoded, not inferred from the repository merely being in some operation
 * state — and Review Hub must actually have opened. Inferring it from state
 * alone was wrong in both directions: an agent starting a cherry-pick in its
 * own PTY between the click and the failure would make an unrelated
 * `worktree-dirty` refusal look like a halt, and the handler's own "already
 * mid-operation" refusal would swallow itself. Either way the user would be
 * shown a conflict panel for an operation that never started, and the caller
 * would be told it succeeded.
 */
async function runBaseIntegration(
  invoke: () => Promise<void>,
  cwd: string,
  location: WorktreeLocationArgs | undefined,
  ctx: ActionContext
): Promise<void> {
  try {
    await invoke();
  } catch (error) {
    await refreshWorktree(location, ctx);
    // `isClientGitError` decodes the `[GitError|<reason>|…]` prefix the preload
    // sets when crossing the contextBridge, and attaches `gitReason` in place.
    // Its sibling `readGitErrorFields` would do too, but lives in the ReviewHub
    // module graph — importing that here pulls a panel's dependencies into
    // every action-definition test.
    const isConflict = isClientGitError(error) && error.gitReason === "conflict-unresolved";
    if (isConflict && (await routeHaltToReviewHub(cwd, location, ctx))) return;
    reportGitFailure(error, location, ctx);
    throw error;
  }
  await refreshWorktree(location, ctx);
}

/**
 * Surface a failed git operation to the person who asked for it.
 *
 * It belongs here rather than at each call site because `ActionService.dispatch`
 * CATCHES an action's error and resolves `{ok: false}` — a menu row's
 * `void dispatch(...)` therefore discards every failure silently, and so does a
 * palette pick and a keybinding. Reporting once, here, covers all of them.
 *
 * The copy comes from `humanizeAppError` off the classified `gitReason`, not
 * from the raw message: that is the single translation point between an
 * internal git string and a toast, and it carries the per-reason recovery hint
 * with it.
 *
 * Skipped for agent dispatch, which gets the error as its tool result and has
 * no screen to read a toast on.
 */
function reportGitFailure(
  error: unknown,
  location: WorktreeLocationArgs | undefined,
  ctx: ActionContext
): void {
  if (ctx.dispatchSource === "agent") return;
  const gitReason = isClientGitError(error) ? error.gitReason : undefined;
  const { title, body } = humanizeAppError({
    type: "git",
    source: "gitActions",
    message: formatErrorMessage(error, "The git operation did not complete."),
    gitReason,
    // The handler's own sentence, which is written for this surface and names
    // the specific blocker — `humanizeAppError` prefers it over the generic
    // per-type fallback, and only reaches for the reason's stock hint when
    // there is nothing better.
    recoveryHint: isClientGitError(error) ? error.message : undefined,
  });
  const worktreeId = resolveWorktreeIdOrNull(location, ctx);
  if (!worktreeId) {
    // No worktree the renderer can name means no panel to send them to, and a
    // recovery button that opened nothing would be worse than none.
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify({ type: "error", title, message: body, context: { eventKind: "git" } });
    return;
  }
  notify({
    type: "error",
    title,
    message: body,
    context: { eventKind: "git" },
    // One recovery action, and the one that actually helps: every failure here
    // is something the user resolves by looking at the worktree's changes.
    action: {
      label: "Open Review Hub",
      onClick: () => {
        void actionService.dispatch(
          "worktree.openReviewHub",
          { worktreeId },
          ctx.dispatchSource ? { source: ctx.dispatchSource } : undefined
        );
      },
    },
  });
}

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
      "Stage every change in the worktree for the next commit — modifications, new files, deletions and renames alike. This is broader than it looks — it sweeps in unrelated edits — so read the staging status first when the commit is meant to be scoped. Reversible by unstaging everything.",
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
    run: async (args: unknown, ctx: ActionContext) => {
      // Everything is inside the try, including `requireWorktreePath`. The
      // action advertises `selfNotifiesOnExecutionError`, which tells the
      // palette to stand its own toast down — so anything that escapes
      // un-notified is silently swallowed, and "no worktree in context" is
      // exactly the failure a user most needs told about.
      try {
        const { prune, ...location } = (args ?? {}) as WorktreeLocationArgs & { prune?: boolean };
        const resolvedCwd = requireWorktreePath(location, ctx);
        // No confirm, unlike its push/pull-rebase neighbours: a fetch writes
        // only remote-tracking refs, so there is no local work it can destroy
        // and nothing a confirm would protect.
        await window.electron.git.fetch({ cwd: resolvedCwd, prune: prune === true });
      } catch (err) {
        // Decode first: a `GitOperationError` crossing the contextBridge carries
        // its reason as a `[GitError|…]` message prefix and `formatErrorMessage`
        // hands the message back verbatim, so a toast built without this shows
        // the transport prefix to the user. The guard strips it in place.
        isClientGitError(err);
        const message = formatErrorMessage(err, "Could not reach the remote.");
        notify({
          type: "error",
          priority: "high",
          title: "Fetch failed",
          message,
          action: {
            label: "Copy details",
            successLabel: "Copied",
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(message);
              } catch {
                // Clipboard write is non-critical; the message is on screen.
              }
            },
          },
          // `git`, not `uiFeedback`: the latter is a silencing kind and would
          // suppress this toast entirely, which is the one outcome a failed
          // fetch must not have.
          context: { eventKind: "git" },
        });
        throw err;
      }
    },
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
    title: "Rebase onto Base Branch",
    description: "Replay this worktree's commits on top of its base branch",
    category: "git",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Rewrites local history: every replayed commit gets a new hash, and a branch that is already pushed needs a force-push afterwards.",
    argsSchema: withWorktreeLocation({ baseBranch: BaseBranchSchema }, { legacy: ["cwd"] }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { baseBranch, ...location } = readBaseIntegrationArgs(args);
      const resolvedCwd = requireWorktreePath(location, ctx);
      // The commits the dialog previewed. Handed to the write so it refuses if
      // either has moved since — an agent committing into the worktree while
      // the dialog is open is ordinary in this product, not a corner case.
      let pinned: { branch?: string; headOid?: string; baseOid?: string } | null = null;
      if (ctx.dispatchSource !== "agent") {
        const result = await useGitWorktreeOperationConfirmStore
          .getState()
          .requestConfirmation({ kind: "rebase-onto-base", cwd: resolvedCwd, baseBranch });
        if (!result.confirmed) return;
        pinned = result.pinned;
      }
      await runBaseIntegration(
        () => window.electron.git.rebaseOntoBase(resolvedCwd, baseBranch, pinned ?? undefined),
        resolvedCwd,
        location,
        ctx
      );
    },
  }));

  actions.set("git.mergeBaseIntoBranch", () => ({
    id: "git.mergeBaseIntoBranch",
    title: "Merge Base Branch In",
    description: "Merge this worktree's base branch into its current branch",
    category: "git",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Extends local history with a merge commit. Existing commits keep their hashes, but the merge itself is only undone by resetting the branch.",
    argsSchema: withWorktreeLocation({ baseBranch: BaseBranchSchema }, { legacy: ["cwd"] }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { baseBranch, ...location } = readBaseIntegrationArgs(args);
      const resolvedCwd = requireWorktreePath(location, ctx);
      let pinned: { branch?: string; headOid?: string; baseOid?: string } | null = null;
      if (ctx.dispatchSource !== "agent") {
        const result = await useGitWorktreeOperationConfirmStore
          .getState()
          .requestConfirmation({ kind: "merge-base", cwd: resolvedCwd, baseBranch });
        if (!result.confirmed) return;
        pinned = result.pinned;
      }
      await runBaseIntegration(
        () => window.electron.git.mergeBaseIntoBranch(resolvedCwd, baseBranch, pinned ?? undefined),
        resolvedCwd,
        location,
        ctx
      );
    },
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
    title: "Abort Git Operation",
    description: "Abort the merge, rebase, cherry-pick, or revert this worktree is halted on",
    category: "git",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Discards staged conflict resolutions and any commits already replayed, returning the worktree to its pre-operation state.",
    argsSchema: withWorktreeLocation({ operation: RepoOperationStateSchema }, { legacy: ["cwd"] }),
    run: async (args: unknown, ctx: ActionContext) => {
      const { operation, ...location } = (args ?? {}) as WorktreeLocationArgs & {
        operation?: RepoOperationState;
      };
      const resolvedCwd = requireWorktreePath(location, ctx);
      if (ctx.dispatchSource !== "agent") {
        const result = await useGitWorktreeOperationConfirmStore.getState().requestConfirmation({
          kind: "abort-operation",
          cwd: resolvedCwd,
          // The dialog re-reads the real state and prefers its answer; this is
          // only the label to show while that read is in flight.
          operation: operation ?? "REBASING",
        });
        if (!result.confirmed) return;
      }
      try {
        await window.electron.git.abortRepositoryOperation(resolvedCwd);
      } catch (error) {
        await refreshWorktree(location, ctx);
        reportGitFailure(error, location, ctx);
        throw error;
      }
      await refreshWorktree(location, ctx);
    },
  }));

  actions.set("git.continueRepositoryOperation", () => ({
    id: "git.continueRepositoryOperation",
    title: "Continue Git Operation",
    description: "Continue the merge, rebase, cherry-pick, or revert this worktree is halted on",
    category: "git",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: withWorktreeLocation({}, { legacy: ["cwd"] }).optional(),
    run: async (args: unknown, ctx: ActionContext) => {
      const location = (args ?? {}) as WorktreeLocationArgs;
      const resolvedCwd = requireWorktreePath(location, ctx);
      try {
        await window.electron.git.continueRepositoryOperation(resolvedCwd);
      } catch (error) {
        // `--continue` can advance the operation and THEN stop on the next
        // conflict, which throws while having genuinely moved the worktree. So
        // both refresh AND halt-routing have to happen here as well as on the
        // success path — a `finally` refresh alone would leave the user on a
        // card showing the step before last, with the conflict panel unopened
        // because the throw skipped past the routing call.
        await refreshWorktree(location, ctx);
        const isConflict = isClientGitError(error) && error.gitReason === "conflict-unresolved";
        if (isConflict && (await routeHaltToReviewHub(resolvedCwd, location, ctx))) return;
        reportGitFailure(error, location, ctx);
        throw error;
      }
      await refreshWorktree(location, ctx);
      // Not gated on an error: a continue that SUCCEEDS still leaves the
      // worktree mid-rebase whenever there are more commits to replay, and that
      // is the ordinary case rather than a failure.
      await routeHaltToReviewHub(resolvedCwd, location, ctx);
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
