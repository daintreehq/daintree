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
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import {
  buildGitRemoteOperationPreview,
  formatGitPushDestination,
  type GitRemoteOperationPreview,
} from "@/components/Git/gitRemoteOperationPreview";

/**
 * D2 confirm for `git.push` dispatched from the action palette or a keybinding
 * (#8242). Reads the pending request from `gitPushConfirmStore`, previews the
 * resolved destination and the commits the push would actually publish, and
 * resolves the deferred Promise the action `run()` is awaiting.
 *
 * The three things that decide the layout (#11979):
 *
 * 1. The title is fixed. It used to interpolate whatever had loaded, so it read
 *    `Push 'current branch'?` mid-flight, then `Push 'origin/main'?` — and the
 *    quoted string silently changed from naming the LOCAL branch to naming the
 *    REMOTE ref between states. The refs now live in the summary, which is a
 *    place that can hold a pending state honestly.
 * 2. Everything that decides whether the push may proceed — destination, range,
 *    load failure, retry — is inside one preview region, so a blocked push and
 *    the reason for it are never in different parts of the dialog.
 * 3. The commits shown are the publish range, not recent history. See
 *    `buildGitRemoteOperationPreview`.
 */
function GitPushConfirmDialogInner() {
  const pendingConfirm = useGitPushConfirmStore((s) => s.pendingConfirm);
  const resolveConfirmation = useGitPushConfirmStore((s) => s.resolveConfirmation);

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
   * DIFFERENT worktree renders the previous worktree's branch, destination and
   * commits for the frames between render and effect, with Push enabled against
   * them.
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
      // Shared with the MCP confirm surface so agent and human approvers see
      // the identical fresh destination and publish range (#11538).
      buildGitRemoteOperationPreview(cwd, "push")
        .then((result) => {
          if (requestIdRef.current !== requestId) return;
          setPreview(result);
          setLoadedFor(cwd);
        })
        .catch((err: unknown) => {
          if (requestIdRef.current !== requestId) return;
          // `git:list-push-commits` fails as a `GitOperationError`, and the
          // preload carries its discriminant across the realm boundary encoded
          // INTO the message (`[GitError|<reason>||<branch>] fatal: …`). The
          // guard strips that prefix in place and is idempotent, so format
          // after calling it or the dialog shows the user the encoding.
          isClientGitError(err);
          setLoadError(formatErrorMessage(err, "Git ended the read without saying why."));
        })
        .finally(() => {
          if (requestIdRef.current !== requestId) return;
          setIsLoading(false);
        }),
      { context: "GitPushConfirmDialog: load push preview" }
    );
  }, [cwd]);

  useEffect(() => {
    if (!cwd) {
      // Bumped, not just cleared: a request already in flight when the dialog
      // closes would otherwise land its `.then` and repopulate state while
      // hidden, ready to be shown to whatever asks next.
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
  // animation-delay, so it is free. The footer hint is plain text and had no
  // gate at all, which put a "checking…" line on screen for fetches that
  // resolved before the bones ever became visible.
  const showPendingHint = useDeferredLoading(isLoading, UI_DOHERTY_THRESHOLD);

  // Resolve false on unmount to prevent a leaked awaited Promise.
  useEffect(() => {
    return () => {
      if (useGitPushConfirmStore.getState().pendingConfirm) {
        useGitPushConfirmStore.getState().resolveConfirmation(false);
      }
    };
  }, []);

  if (!pendingConfirm) return null;

  const branch = preview?.branch ?? null;
  const destination = preview?.destination ?? null;
  const commits = preview?.commits ?? null;
  const pushRange = preview?.pushRange ?? null;
  const hasRemote = preview?.hasRemote ?? true;
  const destinationLabel = destination ? formatGitPushDestination(destination) : null;
  // Settled means "this request's own fresh answer is on screen". `isLoading`
  // starts false and the fetch only begins in an effect, so a check that asked
  // merely whether loading had finished classified the first painted frame as
  // "no destination" and flashed that error before anything had been read.
  const isSettled = !isLoading && !loadError && loadedFor === cwd;
  const isPending = !isSettled && !loadError;
  // Checked before detached HEAD: a halted rebase detaches HEAD too, and telling
  // someone mid-rebase to check out a branch is the wrong diagnosis and the
  // wrong fix. A merge in progress keeps its branch, and git pushes it as usual.
  const haltedOperation = isSettled && branch === null ? (preview?.repoOperation ?? null) : null;
  // Checked BEFORE the missing-destination branch. A detached HEAD also resolves
  // no destination, but telling someone with no branch checked out to configure
  // a push remote for it is both the wrong diagnosis and an unfollowable fix.
  const isDetached = isSettled && commits !== null && branch === null && !haltedOperation;
  const isRemoteMissing = isSettled && branch !== null && !hasRemote;
  const isDestinationMissing = isSettled && branch !== null && hasRemote && destination === null;
  const isLoaded = isSettled && commits !== null && destination !== null;
  const isCreatingBranch = pushRange?.rangeBasis === "creates";
  const isUnverified = pushRange?.rangeBasis === "unverified";
  const behind = pushRange?.behind ?? 0;
  // "Already has everything" is a categorical claim, so it needs a range that was
  // actually settled against the destination. An unverified one was not, and an
  // empty one there means "nothing found locally", not "nothing to send".
  const isInSync = isLoaded && commits.length === 0 && !isUnverified && behind === 0;
  const isEmptyUnverified = isLoaded && commits.length === 0 && isUnverified;
  const total = pushRange?.total ?? commits?.length ?? 0;
  const hasOutgoing = isLoaded && commits.length > 0;
  // A push that will go ahead but not as it looks: git will refuse it, or the
  // list is an estimate. The warning leads, and the consequence moves to the
  // footnote rather than sitting above the thing the user most needs to read.
  const hasWarning = isLoaded && (behind > 0 || isUnverified);

  // A destination nobody can name can't be approved — the handler would refuse
  // the write anyway, and guessing `origin` is the bug (#11746). `commits === null`
  // is "not loaded", which is a different thing from a loaded empty range: an
  // in-sync branch is approvable and pushes nothing (#9575).
  //
  // A diverged destination is NOT blocked. Git refuses the push itself, and that
  // refusal is the one moment the force-push lease can be captured (#7822) — a
  // confirm that blocked here would take away the only route to that recovery.
  const confirmDisabled = !isSettled || commits === null || !destination || !!loadError;

  // Names the one unmet prerequisite rather than leaving a dead button to be
  // read as arbitrary. Ordered by which the user can act on first, and short
  // enough to sit on one line beside the buttons.
  const blockedReason = loadError
    ? "Retry the preview to continue"
    : haltedOperation
      ? `Finish the ${OPERATION_LABEL[haltedOperation].toLowerCase()} to continue`
      : isDetached
        ? "Check out a branch to continue"
        : isRemoteMissing
          ? "Add a remote to continue"
          : isDestinationMissing
            ? "Set a destination to continue"
            : showPendingHint
              ? "Checking what this would publish…"
              : null;

  const notice = loadError ? (
    <PreviewNotice
      tone="error"
      title="Couldn't read what this would publish"
      onRetry={loadPreview}
      retryTestId="git-push-commits-retry"
    >
      {loadError}
    </PreviewNotice>
  ) : haltedOperation ? (
    <PreviewNotice
      tone="error"
      title={`${OPERATION_LABEL[haltedOperation]} in progress`}
      testId="git-push-operation-in-progress"
    >
      {buildInProgressDescription(
        haltedOperation,
        preview?.rebaseStep ?? null,
        preview?.rebaseTotalSteps ?? null
      )}
    </PreviewNotice>
  ) : isDetached ? (
    <PreviewNotice tone="error" title="No branch checked out" testId="git-push-detached-head">
      This worktree is on a detached HEAD, so there is no branch to publish. Check one out and try
      again.
    </PreviewNotice>
  ) : isRemoteMissing ? (
    <PreviewNotice
      tone="error"
      title="No remote to publish to"
      command="git remote add <name> <url>"
      testId="git-push-no-remote"
    >
      This repository has no remote configured. Add one, then push again to publish the branch:
    </PreviewNotice>
  ) : isDestinationMissing ? (
    <PreviewNotice
      tone="error"
      title="No destination for this branch"
      // `git config branch.<n>.pushRemote <remote>` alone is NOT reliable here:
      // under the default push.default it leaves the push ref empty, the
      // resolver still refuses, and the user lands back on this screen having
      // followed the instruction.
      command={`git push -u <remote> ${branch ?? "<branch>"}`}
      testId="git-push-no-destination"
    >
      Git won&apos;t guess one: the branch has no upstream, or more than one remote could be meant.
      Publishing it to the remote you mean sets the upstream:
    </PreviewNotice>
  ) : isLoaded && behind > 0 ? (
    <PreviewNotice
      tone="warning"
      title={`${destinationLabel} has ${behind} commit${behind === 1 ? "" : "s"} this branch doesn't`}
      testId="git-push-diverged"
    >
      As of the last fetch. Git will refuse this push rather than overwrite them — integrate them
      first, or force push once the push is refused.
    </PreviewNotice>
  ) : isLoaded && isUnverified ? (
    // `unverified` covers two causes the preview can't tell apart — the remote
    // didn't answer, or it named a tip this repository doesn't hold — so the
    // notice states what is known, not which of the two happened.
    <PreviewNotice
      tone="warning"
      title="Couldn't verify the outgoing commits"
      onRetry={loadPreview}
      retryTestId="git-push-unverified-retry"
      testId="git-push-unverified"
    >
      {destinationLabel} couldn&apos;t be checked, so the list below is worked out from this
      repository alone. It may leave out commits this push sends, or include ones the remote already
      has.
    </PreviewNotice>
  ) : null;

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => resolveConfirmation(false)}
      title="Push commits?"
      // Shown while the read is pending and when a push is actually about to
      // publish something. Blocked and empty states drop it: the consequence of a
      // push that can't or won't happen sat above the one fact that mattered,
      // which now leads the frame instead.
      description={
        isPending || (hasOutgoing && !hasWarning) ? (
          <span>
            Publishing puts commits on the remote, where everyone working from it sees them. Taking
            them back afterwards needs a force-push.
          </span>
        ) : undefined
      }
      confirmLabel="Push commits"
      cancelLabel="Cancel"
      variant="destructive"
      hasPreview={true}
      // Deliberately NOT `isConfirmLoading={isLoading}`. That prop means "the
      // confirmed action is running": it overlays a spinner on the primary,
      // dims its label to 30%, and disables Cancel. Wiring the PREVIEW fetch to
      // it drew a spinner across the word "Push", and made Cancel unavailable
      // for the whole fetch — a preview fetch is not a reason to take away the
      // way out of the dialog.
      confirmDisabled={confirmDisabled}
      hint={blockedReason}
      onConfirm={() => resolveConfirmation(true)}
    >
      <PreviewFrame>
        {notice}
        <PreviewSummary testId="git-push-destination-summary">
          <SummaryRow label="From">
            {branch && isSettled ? (
              <RefChip value={branch} />
            ) : isPending ? (
              <Bone className="w-40" />
            ) : (
              <MissingValue />
            )}
          </SummaryRow>
          <SummaryRow
            label="To"
            aside={
              isLoaded && isCreatingBranch
                ? "creates this branch"
                : isLoaded && isUnverified
                  ? "not verified"
                  : undefined
            }
          >
            {destinationLabel && isSettled ? (
              <RefChip value={destinationLabel} />
            ) : isPending ? (
              <Bone className="w-48" />
            ) : (
              <MissingValue label={isDestinationMissing ? "Not resolved" : "—"} />
            )}
          </SummaryRow>
        </PreviewSummary>

        {isPending && (
          <PreviewSkeleton
            label="Checking what this would publish"
            testId="git-push-commits-loading"
          />
        )}

        {isInSync && (
          <PreviewNote testId="git-push-in-sync">
            Nothing to publish &mdash; as of the last fetch, {destinationLabel} already has
            everything on this branch.
          </PreviewNote>
        )}

        {isEmptyUnverified && (
          <PreviewNote testId="git-push-empty-unverified">
            Nothing found to publish, but that isn&apos;t confirmed.
          </PreviewNote>
        )}

        {isLoaded && commits.length > 0 && (
          <>
            <PreviewSectionHeading
              label={isUnverified ? "Commits to push, unverified" : "Commits to push"}
              count={total}
            />
            <CommitRows
              commits={commits}
              total={total}
              label={`Commits to push to ${destinationLabel}`}
              rowTestId="git-push-commit-row"
              capTestId="git-push-commit-cap"
            />
          </>
        )}
      </PreviewFrame>
      {/* The quietest tier on the surface, and last, and only where a push is
          actually about to happen — not under a divergence warning, which says
          the push will be refused. Ordinarily it answers the one question a push
          raises that nothing else here does. Under the unverified warning, which
          already answers that, it carries the consequence the description would
          have. */}
      {hasOutgoing &&
        behind === 0 &&
        (isUnverified ? (
          <p className="text-2xs text-text-secondary">
            Once published, taking these back needs a force-push.
          </p>
        ) : (
          <p className="text-2xs text-text-secondary">
            If the remote has commits this branch doesn&apos;t by then, Git refuses the push rather
            than overwriting them.
          </p>
        ))}
    </ConfirmDialog>
  );
}

export function GitPushConfirmDialog() {
  // Reset the boundary on each new request so a crashed inner dialog recovers
  // when the next push confirm arrives (#9918). Without a changing key, an inner
  // render crash leaves this boundary stuck for the session.
  const requestSeq = useGitPushConfirmStore((s) => s.requestSeq);
  return (
    <ErrorBoundary
      variant="component"
      componentName="GitPushConfirmDialog"
      resetKeys={[requestSeq]}
    >
      <GitPushConfirmDialogInner />
    </ErrorBoundary>
  );
}
