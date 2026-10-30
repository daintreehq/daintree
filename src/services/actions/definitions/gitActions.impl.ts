// The git actions' run bodies, loaded on first dispatch by `runGitAction` in
// gitActions.ts, which keeps the metadata every view registers at boot (#14239).
// Nothing here may import gitActions.ts at runtime.
import type { ActionContext } from "@shared/types/actions";
import { GitStatusSchema, decodeIndexCursor } from "./schemas";
import { requireWorktreeId, requireWorktreePath, type WorktreeLocationArgs } from "./locationArgs";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import { useGitWorktreeOperationConfirmStore } from "@/store/gitWorktreeOperationConfirmStore";
import { useGitForcePushStore } from "@/store/gitForcePushStore";
import { useFileMutationConfirmStore } from "@/store/fileMutationConfirmStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
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
} from "@shared/config/gitReadLimits";
import type { ConflictedFileEntry, StagingFileEntry } from "@shared/types/git";
import { projectPulseForAction } from "@shared/utils/pulseProjection";
import { z } from "zod";
import { mintRemoteOperationId } from "@/clients/operationsClient";
import { runHostOperation } from "@/hooks/useHostConnection";
import { fileMutationArgsSchema } from "./gitActionArgs";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.trunc(value) || min, min), max);

/** The parsed args of an action built with `withWorktreeLocation({ baseBranch })`. */
interface BaseIntegrationArgs extends WorktreeLocationArgs {
  baseBranch: string;
}

/**
 * Read a base-integration action's validated args.
 *
 * The cast is unavoidable — `run` receives `unknown` and the shape is only
 * knowable from the `argsSchema` in gitActions.ts — but it is written ONCE
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
    context: { worktreeId, eventKind: "git" },
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

export const gitActionRuns = {
  "git.getProjectPulse": async (args: unknown, ctx: ActionContext) => {
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

    return projectPulseForAction(pulse, rangeDays);
  },
  "git.getFileDiff": async (args: unknown, ctx: ActionContext) => {
    const { filePath, status, ignoreWhitespace, side, offset, maxBytes, ...location } =
      args as WorktreeLocationArgs & {
        filePath: string;
        status: z.infer<typeof GitStatusSchema>;
        ignoreWhitespace?: boolean;
        side?: "staged" | "unstaged";
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
        side,
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
  "git.listCommits": async (args: unknown, ctx: ActionContext) => {
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
    const limit = clamp(rawLimit ?? GIT_LIST_COMMITS_LIMIT_DEFAULT, 1, GIT_LIST_COMMITS_LIMIT_MAX);
    const result = await window.electron.git.listCommits({
      ...filters,
      cwd: resolvedCwd,
      skip,
      limit,
      includeTotal: true,
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
  "git.stageFile": async (args: unknown, ctx: ActionContext) => {
    const { filePath, ...location } = args as WorktreeLocationArgs & { filePath: string };
    await window.electron.git.stageFile(requireWorktreePath(location, ctx), filePath);
  },
  "git.unstageFile": async (args: unknown, ctx: ActionContext) => {
    const { filePath, ...location } = args as WorktreeLocationArgs & { filePath: string };
    await window.electron.git.unstageFile(requireWorktreePath(location, ctx), filePath);
  },
  "git.discardFileChanges": async (args: unknown, ctx: ActionContext) => {
    const { filePath, ...location } = fileMutationArgsSchema.parse(args);
    const worktreePath = requireWorktreePath(location, ctx);
    // Same split as `git.pullRebase`: an agent dispatch was already cleared
    // against the MCP bridge's own confirm, and this deferred store can only
    // be resolved by a renderer dialog a headless caller cannot reach.
    let expectedToken: string | undefined;
    if (ctx.dispatchSource !== "agent") {
      const approval = await useFileMutationConfirmStore
        .getState()
        .requestConfirmation({ kind: "discard", relativePath: filePath, worktreePath });
      if (!approval) return;
      // The discard refuses if the file moved after the preview was read, so
      // what goes is what the user saw.
      expectedToken = approval.token ?? undefined;
    }
    try {
      await window.electron.git.discardFileChanges({
        worktreePath,
        relativePath: filePath,
        ...(expectedToken !== undefined && { expectedToken }),
      });
    } finally {
      await refreshWorktree(location, ctx);
    }
  },
  "git.stageAll": async (args: unknown, ctx: ActionContext) => {
    await window.electron.git.stageAll(
      requireWorktreePath(args as WorktreeLocationArgs | undefined, ctx)
    );
  },
  "git.unstageAll": async (args: unknown, ctx: ActionContext) => {
    await window.electron.git.unstageAll(
      requireWorktreePath(args as WorktreeLocationArgs | undefined, ctx)
    );
  },
  "git.commit": async (args: unknown, ctx: ActionContext) => {
    const { message, ...location } = (args ?? {}) as WorktreeLocationArgs & { message?: string };
    const resolvedCwd = requireWorktreePath(location, ctx);
    const trimmed = message?.trim();
    if (!trimmed) throw new Error("Commit message is required");
    return await window.electron.git.commit(resolvedCwd, trimmed);
  },
  "git.push": async (args: unknown, ctx: ActionContext) => {
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
    // A rejection is the ONLY moment a `--force-with-lease` SHA may be read
    // (#7822), and `handlePush` is the only thing that reads it — inside its
    // own catch, against the destination it actually pushed to. Stashing it
    // here is what lets the card menu offer a force push later without
    // re-deriving anything. The previous lease is dropped first: once a new
    // push has run, an older capture describes a remote state nobody has
    // observed since.
    const forcePush = useGitForcePushStore.getState();
    forcePush.clearRecovery(resolvedCwd);
    try {
      const opId = mintRemoteOperationId();
      // A push has no result to rebuild; a lost answer settles on the host's outcome.
      return await runHostOperation(
        opId,
        () =>
          opId
            ? window.electron.git.push(resolvedCwd, setUpstream, opId)
            : window.electron.git.push(resolvedCwd, setUpstream),
        { fromResult: () => undefined }
      );
    } catch (error) {
      if (isClientGitError(error) && error.gitReason === "push-rejected-outdated") {
        // `recordRejection` stores nothing when either field is missing, so a
        // rejection whose `git.revparse` failed leaves no row to click rather
        // than a row that would force without a lease.
        forcePush.recordRejection({
          cwd: resolvedCwd,
          branchName: error.branchName,
          leaseSha: error.leaseSha,
        });
      }
      throw error;
    }
  },
  "git.pullRebase": async (args: unknown, ctx: ActionContext) => {
    const resolvedCwd = requireWorktreePath(args as WorktreeLocationArgs | undefined, ctx);
    // Palette, keybinding, and the terminal push-error recovery banner reach
    // run() ungated, so enforce the rebase confirm here (#8242). The ReviewHub
    // CTA calls the IPC directly, but asks the same store for its confirm, so
    // every entry point shows one dialog. Agent dispatch is skipped for
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
  "git.fetch": async (args: unknown, ctx: ActionContext) => {
    // Everything is inside the try, including `requireWorktreePath`. The
    // action advertises `selfNotifiesOnExecutionError`, which tells the
    // palette to stand its own toast down — so anything that escapes
    // un-notified is silently swallowed, and "no worktree in context" is
    // exactly the failure a user most needs told about.
    let worktreeId: string | null = null;
    try {
      const { prune, ...location } = (args ?? {}) as WorktreeLocationArgs & { prune?: boolean };
      worktreeId = resolveWorktreeIdOrNull(location, ctx);
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
        context: { worktreeId: worktreeId ?? undefined, eventKind: "git" },
      });
      throw err;
    }
  },
  "git.rebaseOntoBase": async (args: unknown, ctx: ActionContext) => {
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
  "git.mergeBaseIntoBranch": async (args: unknown, ctx: ActionContext) => {
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
  "git.abortRepositoryOperation": async (args: unknown, ctx: ActionContext) => {
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
  "git.continueRepositoryOperation": async (args: unknown, ctx: ActionContext) => {
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
  "git.forcePushWithLease": async (args: unknown, ctx: ActionContext) => {
    const resolvedCwd = requireWorktreePath(args as WorktreeLocationArgs | undefined, ctx);
    const store = useGitForcePushStore.getState();
    const record = store.getRecovery(resolvedCwd);
    if (!record) {
      throw new Error(
        "Force push is available only after a push was rejected because the remote moved"
      );
    }

    // Copied out before the first await. The store entry can be replaced
    // while the confirm is open, and the operation must run against the
    // lease the user was actually shown.
    const { branchName, leaseSha, generation } = record;

    // Agent dispatch has already cleared ActionService's host-attested
    // confirm gate, and this deferred store resolves only from a renderer
    // dialog no headless client can click — awaiting it would hang (#11538).
    if (ctx.dispatchSource !== "agent") {
      const confirmed = await store.requestConfirmation(record);
      // Declining is a normal outcome, not a failure — but a caller cannot
      // tell it from a completed push unless the two return different
      // things. ReviewHub's banner keys its own recovery state off this.
      if (!confirmed) return { forced: false };
      // A push that ran while the dialog was open replaced the lease. The
      // confirm was granted against the old one, so it does not carry over.
      const current = useGitForcePushStore.getState().getRecovery(resolvedCwd);
      if (!current || current.generation !== generation) {
        throw new Error("The push state changed while confirming — try pushing again");
      }
    }

    try {
      await window.electron.git.forcePushWithLease(resolvedCwd, branchName, leaseSha);
    } catch (error) {
      // Decode before rethrowing. The preload ships the discriminant fields
      // inside an `[GitError|reason|lease|branch]` message prefix, and
      // `isClientGitError` strips it as a side effect — without this, every
      // consumer downstream (the ReviewHub banner, the card toast) classifies
      // and displays the encoded envelope instead of the message.
      const decoded = isClientGitError(error);
      // A rejection means the remote refused the lease: it is no longer where
      // it stood when the push that captured it was rejected, so the record
      // describes a state that has been disproven. Transport and auth
      // failures say nothing about the remote's position and keep it for a
      // retry. Matched on the message because `GitOperationReason` has no
      // member for a failed lease — git's own `stale info` is the signal.
      if (decoded && /\bstale info\b|\[rejected\]/i.test(error.message)) {
        useGitForcePushStore.getState().clearRecovery(resolvedCwd, generation);
      }
      useAnnouncerStore.getState().announce(`Couldn't force push ${branchName}`, "assertive");
      throw error;
    }
    // Conditional on the generation: a push that landed during the force
    // push owns the record now, and clearing it would drop a lease this call
    // never held.
    useGitForcePushStore.getState().clearRecovery(resolvedCwd, generation);
    useAnnouncerStore.getState().announce(`Force pushed ${branchName}`);
    return { forced: true };
  },
  "git.markSafeDirectory": async (args: unknown, ctx: ActionContext) => {
    await window.electron.git.markSafeDirectory(
      requireWorktreePath(args as WorktreeLocationArgs | undefined, ctx)
    );
  },
  "git.retryAuthFetch": async () => {
    await window.electron.worktree.retryAuthFetch();
  },
  "git.getStagingStatus": async (args: unknown, ctx: ActionContext) => {
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
} satisfies Record<string, (args: unknown, ctx: ActionContext) => Promise<unknown>>;

export type GitActionRunId = keyof typeof gitActionRuns;
