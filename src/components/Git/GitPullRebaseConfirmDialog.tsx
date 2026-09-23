import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  Bone,
  CommitRows,
  MissingValue,
  PreviewFrame,
  PreviewNote,
  PreviewNotice,
  PreviewSectionHeading,
  PreviewSkeleton,
  PreviewSummary,
  RefChip,
  SummaryRow,
} from "@/components/Git/GitOperationPreview";
import { OPERATION_LABEL, buildInProgressDescription } from "@/components/Git/repoOperationCopy";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { isClientGitError } from "@/utils/clientGitError";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import {
  buildGitRemoteOperationPreview,
  formatGitPushDestination,
  type GitRemoteOperationPreview,
} from "@/components/Git/gitRemoteOperationPreview";

/**
 * D1 confirm for the `git.pullRebase` action dispatched outside the ReviewHub
 * (palette, keybinding, terminal push-error recovery banner) (#8242). Reads the
 * pending request from `gitPullRebaseConfirmStore`, previews the upstream and the
 * local commits a rebase would actually replay, and resolves the deferred Promise
 * the action `run()` is awaiting.
 *
 * Built as the mirror of `GitPushConfirmDialog`, not a copy of it (#11980). The
 * shell, the preview frame and the row treatment are shared so the two read as one
 * family; what differs is the thing being described. A push is a TRANSFER to a
 * destination, so its summary reads From/To. A rebase is a REWRITE of local history
 * against a source, so this one reads Onto/Rewrites — the upstream is the new base,
 * and the branch is what gets rebuilt on top of it.
 *
 * The three things that decide the layout:
 *
 * 1. The title is fixed. It used to interpolate `branch ?? "current branch"`, so a
 *    dialog opened before the read landed asked `Pull and rebase 'current branch'?`
 *    — and on a failed read it stayed that way. The refs now live in the summary,
 *    which is a place that can hold a pending state honestly. `useMcpBridge` already
 *    settled the same question for the agent-facing surface: a title that mutates
 *    after open changes the dialog's accessible name without re-announcing it.
 * 2. Everything that decides whether the rebase may proceed — upstream, range, load
 *    failure, retry — is inside one preview region. The missing-upstream warning used
 *    to sit ABOVE the frame while the frame below it went on listing commits under
 *    "Local commits to replay", so the dialog stated a blocking condition and then
 *    contradicted it 30px lower.
 * 3. The commits shown are the replay set, not recent history. See
 *    `buildGitRemoteOperationPreview`.
 */
function GitPullRebaseConfirmDialogInner() {
  const pendingConfirm = useGitPullRebaseConfirmStore((s) => s.pendingConfirm);
  const resolveConfirmation = useGitPullRebaseConfirmStore((s) => s.resolveConfirmation);

  const cwd = pendingConfirm?.cwd ?? null;

  const [preview, setPreview] = useState<GitRemoteOperationPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  /**
   * The cwd the currently-held preview actually describes.
   *
   * Approval is gated on this matching the pending request, not merely on
   * "something loaded". The dialog keeps its state across close/open — the host
   * stays mounted and only returns null — so without this a second confirm for a
   * DIFFERENT worktree renders the previous worktree's branch, upstream and commits
   * for the frames between render and effect, with Pull and rebase enabled against
   * them. In a window holding a dozen worktrees whose branches are all called
   * something like `main`, nothing on screen would give that away.
   */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const loadPreview = useCallback(() => {
    if (!cwd) return;
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setLoadError(null);
    setPreview(null);
    setLoadedFor(null);

    safeFireAndForget(
      // Shared with the MCP confirm surface so agent and human approvers see the
      // identical fresh upstream and replay set (#11538).
      buildGitRemoteOperationPreview(cwd, "pull-rebase")
        .then((result) => {
          if (requestIdRef.current !== requestId) return;
          setPreview(result);
          setLoadedFor(cwd);
        })
        .catch((err: unknown) => {
          if (requestIdRef.current !== requestId) return;
          // `git:list-rebase-commits` fails as a `GitOperationError`, and the preload
          // carries its discriminant across the realm boundary encoded INTO the
          // message (`[GitError|<reason>||<branch>] fatal: …`). The guard strips that
          // prefix in place and is idempotent, so format after calling it or the
          // dialog shows the user the encoding.
          isClientGitError(err);
          setLoadError(formatErrorMessage(err, "Git ended the read without saying why."));
        })
        .finally(() => {
          if (requestIdRef.current !== requestId) return;
          setIsLoading(false);
        }),
      { context: "GitPullRebaseConfirmDialog: load rebase preview" }
    );
  }, [cwd]);

  useEffect(() => {
    if (!cwd) {
      // Bumped, not just cleared: a request already in flight when the dialog closes
      // would otherwise land its `.then` and repopulate state while hidden, ready to
      // be shown to whatever asks next.
      requestIdRef.current++;
      setPreview(null);
      setLoadedFor(null);
      setLoadError(null);
      setIsLoading(false);
      return;
    }
    loadPreview();
  }, [cwd, loadPreview]);

  // The skeleton's 400ms gate lives in `animate-pulse-delayed`'s own
  // animation-delay, so it is free. The footer hint is plain text and has no gate of
  // its own, which would otherwise put a "checking…" line on screen for reads that
  // resolve before the bones ever become visible.
  const showPendingHint = useDeferredLoading(isLoading, UI_DOHERTY_THRESHOLD);

  // Resolve false on unmount to prevent a leaked awaited Promise.
  useEffect(() => {
    return () => {
      if (useGitPullRebaseConfirmStore.getState().pendingConfirm) {
        useGitPullRebaseConfirmStore.getState().resolveConfirmation(false);
      }
    };
  }, []);

  if (!pendingConfirm) return null;

  const branch = preview?.branch ?? null;
  // The UPSTREAM, not the push destination: this dialog confirms a rebase onto
  // what the branch integrates from, and in a triangular workflow those are
  // different repositories (#11746).
  const upstream = preview?.pullSource ?? null;
  const commits = preview?.commits ?? null;
  const rebaseRange = preview?.rebaseRange ?? null;
  const hasRemote = preview?.hasRemote ?? true;
  const upstreamLabel = upstream ? formatGitPushDestination(upstream) : null;
  // Settled means "this request's own fresh answer is on screen". `isLoading` starts
  // false and the read only begins in an effect, so a check that asked merely whether
  // loading had finished would classify the first painted frame as "no upstream" and
  // flash that error before anything had been read.
  const isSettled = !isLoading && !loadError && loadedFor === cwd;
  const isPending = !isSettled && !loadError;
  // First of the blocking states: `git pull --rebase` refuses to start over any
  // halted operation, and a halted rebase also detaches HEAD — so without this it
  // read as "no branch checked out", and the fix it offered was the wrong one.
  const haltedOperation = isSettled ? (preview?.repoOperation ?? null) : null;
  // Checked BEFORE the missing-upstream branch. A detached HEAD also resolves no
  // upstream, but telling someone with no branch checked out to set an upstream for
  // it is both the wrong diagnosis and an unfollowable fix.
  const isDetached = isSettled && !haltedOperation && branch === null;
  const isRemoteMissing = isSettled && !haltedOperation && branch !== null && !hasRemote;
  const isUpstreamMissing =
    isSettled && !haltedOperation && branch !== null && hasRemote && upstream === null;
  const isLoaded = isSettled && !haltedOperation && commits !== null && upstream !== null;
  // Git refuses to rebase over uncommitted changes to tracked files, and the
  // handler refuses before it touches the network. Said here, before approval,
  // rather than as a failure after it. The refs and lists still render: what the
  // pull WOULD do is still worth seeing while deciding whether to commit first.
  const conflicts = isLoaded ? (preview?.conflictCount ?? 0) : 0;
  const trackedChanges = isLoaded ? (preview?.trackedChangeCount ?? 0) : 0;
  // Conflicts first: "commit or stash" can't be followed until they're resolved.
  const hasConflicts = conflicts > 0;
  const isDirty = hasConflicts || trackedChanges > 0;
  const isUnfetched = isLoaded && rebaseRange?.rangeBasis === "unfetched";
  const isMeasured = isLoaded && !isUnfetched;
  const total = rebaseRange?.total ?? commits?.length ?? 0;
  const behind = rebaseRange?.behind ?? 0;
  const incoming = rebaseRange?.incoming ?? [];
  const hasReplay = isMeasured && commits.length > 0;
  // Only a moved upstream rewrites anything. With nothing incoming, `git rebase`
  // finds the branch already on its upstream and leaves every commit — and hash —
  // where it is, so a "Rewrites" label and a "Commits to replay" list would
  // promise a rewrite the rebase does not perform. The pull fetches first, so
  // that can still change; the footnote says so.
  const rewrites = hasReplay && behind > 0;
  // A measured-empty replay set does NOT mean "purely behind": it is measured
  // with `--no-merges --cherry-pick --right-only`, so merge commits and commits
  // the upstream already holds as equivalent patches measure empty too — and
  // those are local-only commits the rebase drops rather than fast-forwards
  // past. Neither note below may claim a fast-forward on the strength of
  // `behind` alone.
  const isInSync = isMeasured && commits.length === 0 && behind === 0;

  // An upstream nobody can name can't be approved — the handler would refuse the
  // rebase anyway, and guessing `origin` is the bug (#11746). `commits === null` is
  // "not loaded", which is a different thing from a loaded empty range: a branch
  // level with its upstream is approvable and replays nothing.
  //
  // `isUnfetched` blocks for the same reason the unresolved upstream does. The
  // panel says in as many words that the replay set could not be measured, and a
  // surface whose entire job is showing what gets rewritten must not hand out an
  // approval in the one state where it cannot answer that. Fetching is a
  // non-destructive thing the user can go and do; approving past an unknown is not.
  const confirmDisabled = !isLoaded || isUnfetched || isDirty || !!loadError;

  // Names the one unmet prerequisite rather than leaving a dead button to be read as
  // arbitrary. Ordered by which the user can act on first.
  const blockedReason = loadError
    ? "Retry the preview to continue"
    : haltedOperation
      ? `Finish the ${OPERATION_LABEL[haltedOperation].toLowerCase()} to continue`
      : isDetached
        ? "Check out a branch to continue"
        : isRemoteMissing
          ? "Add a remote to continue"
          : isUpstreamMissing
            ? "Set an upstream to continue"
            : hasConflicts
              ? "Resolve the conflicts to continue"
              : isDirty
                ? "Commit or stash to continue"
                : isUnfetched
                  ? "Fetch the upstream to continue"
                  : showPendingHint
                    ? "Checking what would be replayed…"
                    : null;

  const notice = loadError ? (
    <PreviewNotice
      tone="error"
      title="Couldn't read which commits this would replay"
      onRetry={loadPreview}
      retryTestId="git-pull-rebase-commits-retry"
    >
      {loadError}
    </PreviewNotice>
  ) : haltedOperation ? (
    <PreviewNotice
      tone="error"
      title={`${OPERATION_LABEL[haltedOperation]} in progress`}
      testId="git-pull-rebase-operation-in-progress"
    >
      {buildInProgressDescription(
        haltedOperation,
        preview?.rebaseStep ?? null,
        preview?.rebaseTotalSteps ?? null
      )}
    </PreviewNotice>
  ) : isDetached ? (
    <PreviewNotice
      tone="error"
      title="No branch checked out"
      testId="git-pull-rebase-detached-head"
    >
      This worktree is on a detached HEAD, so there is no branch history to replay. Check one out
      and try again.
    </PreviewNotice>
  ) : isRemoteMissing ? (
    <PreviewNotice
      tone="error"
      title="No remote to pull from"
      command="git remote add <name> <url>"
      testId="git-pull-rebase-no-remote"
    >
      This repository has no remote configured, so there is nothing to pull. Add one first:
    </PreviewNotice>
  ) : isUpstreamMissing ? (
    <PreviewNotice
      tone="error"
      title="No upstream to rebase onto"
      // Carries its argument, unlike the bare `git branch --set-upstream-to` the
      // old copy printed: that form takes a required value. Both halves stay
      // placeholders — the remote branch is the one fact this state does not
      // have, and substituting the local name for it is a silent fallback
      // default on a destructive surface (#7880).
      command="git branch --set-upstream-to=<remote>/<branch>"
      testId="git-pull-rebase-no-destination"
    >
      This branch doesn&apos;t track anything, so there is nothing to replay it onto. Point it at a
      remote branch:
    </PreviewNotice>
  ) : hasConflicts ? (
    <PreviewNotice
      tone="error"
      title={`${conflicts} unresolved conflict${conflicts === 1 ? "" : "s"}`}
      onRetry={loadPreview}
      retryTestId="git-pull-rebase-conflicts-retry"
      testId="git-pull-rebase-conflicts"
    >
      Git won&apos;t replay commits while files are still in conflict. Resolve and stage them in
      Review Hub, then commit or stash and retry.
    </PreviewNotice>
  ) : isDirty ? (
    <PreviewNotice
      tone="error"
      title={`${trackedChanges} uncommitted change${trackedChanges === 1 ? "" : "s"}`}
      onRetry={loadPreview}
      retryTestId="git-pull-rebase-dirty-retry"
      testId="git-pull-rebase-dirty"
    >
      Git won&apos;t replay commits over uncommitted changes to tracked files. Commit or stash them,
      then retry.
    </PreviewNotice>
  ) : isUnfetched ? (
    // Blocking, not a quiet note: the one state where the surface cannot answer
    // the question it exists to answer.
    <PreviewNotice
      tone="error"
      title="Nothing to compare against yet"
      command={`git fetch ${upstream?.remote ?? "<remote>"}`}
      onRetry={loadPreview}
      retryTestId="git-pull-rebase-unfetched-retry"
      testId="git-pull-rebase-empty-unfetched"
    >
      {upstreamLabel} isn&apos;t available locally, so which of your commits would be rewritten
      can&apos;t be worked out. Fetch it and retry. If it&apos;s still missing after that, check
      that the upstream branch exists and that the remote&apos;s fetch settings include it.
    </PreviewNotice>
  ) : null;

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => resolveConfirmation(false)}
      title="Pull and rebase local commits?"
      // Shown while the read is pending and when the rebase will actually rewrite
      // something. Everywhere else it described a rewrite the frame directly below
      // said would not happen — nothing incoming, nothing to replay, or blocked —
      // and it sat above the one fact that mattered. It names the concrete
      // consequence: "the hashes change" is what actually breaks a branch.
      description={
        isPending || (rewrites && !isDirty) ? (
          <span>
            Rebasing replays your local commits on top of the upstream, so each becomes a new commit
            with a different hash and anything pointing at the old ones stops matching.
          </span>
        ) : undefined
      }
      confirmLabel="Pull and rebase"
      cancelLabel="Cancel"
      variant="destructive"
      hasPreview={true}
      // Deliberately NOT `isConfirmLoading={isLoading}`. That prop means "the
      // confirmed action is running": it overlays a spinner on the primary, dims its
      // label to 30%, and disables Cancel. Wiring the PREVIEW read to it drew a
      // spinner across the word "rebase" while the full label was still rendered
      // underneath, and made Cancel unavailable for the whole read — a preview
      // fetch is not a reason to take away the way out of the dialog.
      confirmDisabled={confirmDisabled}
      hint={blockedReason}
      onConfirm={() => resolveConfirmation(true)}
    >
      <PreviewFrame>
        {notice}
        {/* Branch first, then Onto: the pair reads in the order the operation
            happens — this branch is taken and replayed onto that ref. Same
            local-then-remote order as the push's From/To, with the vocabulary
            that keeps a rewrite from reading as a transfer. "Rewrites" only
            where a rewrite is actually on the table. */}
        <PreviewSummary testId="git-pull-rebase-upstream-summary">
          <SummaryRow label={rewrites ? "Rewrites" : "Branch"}>
            {branch && isSettled ? (
              <RefChip value={branch} />
            ) : isPending ? (
              <Bone className="w-40" />
            ) : (
              <MissingValue />
            )}
          </SummaryRow>
          <SummaryRow
            label="Onto"
            aside={
              isMeasured
                ? behind > 0
                  ? `${behind} incoming`
                  : "no incoming commits as of the last fetch"
                : undefined
            }
          >
            {upstreamLabel && isSettled && !haltedOperation ? (
              <RefChip value={upstreamLabel} />
            ) : isPending ? (
              <Bone className="w-48" />
            ) : (
              <MissingValue label={isUpstreamMissing ? "Not resolved" : "—"} />
            )}
          </SummaryRow>
        </PreviewSummary>

        {isPending && (
          <PreviewSkeleton
            label="Checking which commits this would replay"
            testId="git-pull-rebase-commits-loading"
          />
        )}

        {isInSync && (
          <PreviewNote testId="git-pull-rebase-in-sync">
            Nothing incoming and nothing to replay, as of the last fetch.
          </PreviewNote>
        )}

        {/* What comes in, then what gets replayed on top of it — the order the
            rebase applies them. Incoming used to be a count in one empty state
            and invisible everywhere else, so a diverged branch showed two local
            commits and hid the fourteen it was about to be rebuilt on. */}
        {isMeasured && behind > 0 && (
          <>
            <PreviewSectionHeading
              label="Incoming from"
              refName={upstreamLabel ?? undefined}
              count={behind}
            />
            <CommitRows
              commits={incoming}
              total={behind}
              label={`Incoming commits from ${upstreamLabel}`}
              rowTestId="git-pull-rebase-incoming-row"
              compact={hasReplay}
            />
          </>
        )}

        {isMeasured && !isInSync && (
          <PreviewSectionHeading
            label={rewrites || !hasReplay ? "Commits to replay" : "Local commits"}
            count={total}
          />
        )}

        {isMeasured && commits.length === 0 && behind > 0 && (
          <PreviewNote testId="git-pull-rebase-behind-nothing-to-replay">
            None &mdash; {branch} has no commit the rebase would replay on top of these.
          </PreviewNote>
        )}

        {hasReplay && (
          <CommitRows
            commits={commits}
            total={total}
            label={`${rewrites ? "Commits to replay onto" : "Local commits ahead of"} ${upstreamLabel}`}
            rowTestId="git-pull-rebase-commit-row"
            capTestId="git-pull-rebase-commit-cap"
            compact={behind > 0}
          />
        )}
      </PreviewFrame>
      {/* The quietest tier, and last. Freshness first: the counts above are as of
          the last fetch, and the pull fetches again before it replays, so this is
          the one thing about the preview that can change after approval. Then the
          conflict caution, only where there is a replay for it to be about. */}
      {isMeasured && !isDirty && (
        <p className="text-2xs text-text-secondary">
          The pull fetches first, so anything pushed to the upstream since the last fetch comes in
          too.
          {hasReplay &&
            " If a replay hits a conflict, Git stops mid-rebase and leaves the branch there to resolve."}
        </p>
      )}
    </ConfirmDialog>
  );
}

export function GitPullRebaseConfirmDialog() {
  // Reset the boundary on each new request so a crashed inner dialog recovers when
  // the next pull-rebase confirm arrives (#9918). Without a changing key, an inner
  // render crash leaves this boundary stuck for the session.
  const requestSeq = useGitPullRebaseConfirmStore((s) => s.requestSeq);
  return (
    <ErrorBoundary
      variant="component"
      componentName="GitPullRebaseConfirmDialog"
      resetKeys={[requestSeq]}
    >
      <GitPullRebaseConfirmDialogInner />
    </ErrorBoundary>
  );
}
