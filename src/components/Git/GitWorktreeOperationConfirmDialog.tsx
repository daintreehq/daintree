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
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { isClientGitError } from "@/utils/clientGitError";
import { useGitWorktreeOperationConfirmStore } from "@/store/gitWorktreeOperationConfirmStore";
import {
  GIT_REMOTE_COMMIT_PREVIEW_MAX,
  type GitBaseIntegrationCommitPreview,
} from "@shared/types/git";
import type { StagingStatus } from "@shared/types";
import {
  OPERATION_LABEL,
  buildAbortDescription,
  toRepoOperationState,
} from "@/components/Git/repoOperationCopy";

/** Everything the handler will serve, so the tail is a rare cap rather than a routine count. */
const PREVIEW_COMMIT_LIMIT = GIT_REMOTE_COMMIT_PREVIEW_MAX;

/**
 * The wording that differs between the two base operations.
 *
 * Split out as data rather than branched inside the JSX because every string
 * here is a *claim about what happens*, and the two claims are near-opposites:
 * a rebase rewrites this branch's commits, a merge leaves them alone and adds
 * one. Keeping them adjacent is what stops a copy edit to one silently
 * describing the other.
 */
const COPY = {
  "rebase-onto-base": {
    title: "Rebase onto the base branch?",
    description:
      "Rebasing replays your local commits on top of the base branch, so each becomes a new commit with a different hash. If this branch is already pushed, the next push has to be a force-push.",
    confirmLabel: "Rebase onto base",
    /** What `commits` holds for this kind, as a heading. */
    commitsHeading: "Commits to replay",
    subjectLabel: "Rewrites",
    targetLabel: "Onto",
    loadingLabel: "Checking which commits this would replay",
    readFailure: "Couldn't read which commits this would replay",
    /** Rendered only when there is actually something to integrate. */
    footnote:
      "If a replay hits a conflict, Git stops mid-rebase and leaves the branch there to resolve.",
  },
  "merge-base": {
    title: "Merge the base branch in?",
    description:
      "Merging brings the base branch's commits into this branch and adds a merge commit. Existing commits keep their hashes, so a branch that is already pushed does not need a force-push.",
    confirmLabel: "Merge base in",
    commitsHeading: "Commits to bring in",
    subjectLabel: "Into",
    targetLabel: "From",
    loadingLabel: "Checking which commits this would bring in",
    readFailure: "Couldn't read which commits this would bring in",
    footnote:
      "If the merge hits a conflict, Git stops mid-merge and leaves the branch there to resolve.",
  },
} as const;

/**
 * The fresh read a pending request is waiting on.
 *
 * A union rather than two independent state slots: all three kinds need the
 * same "did THIS request's own answer land" guarantee, and duplicating the
 * request-id, loaded-for and retry machinery per kind is how one of the two
 * copies ends up missing a guard.
 */
type LoadedPayload =
  | { kind: "base-integration"; preview: GitBaseIntegrationCommitPreview }
  | { kind: "abort-operation"; status: StagingStatus };

/**
 * Separator for the request identity key.
 *
 * Deliberately NOT relied on for uniqueness — it is legal in both POSIX paths
 * and git refs, so crafted inputs can collide across the joined fields. The
 * monotonic request sequence in the same key is what actually makes it unique;
 * this only keeps the common case readable.
 */
const KEY_SEP = "␟";

/**
 * Confirm for the worktree Git submenu's history-changing rows (#12092).
 *
 * Built as a sibling of `GitPullRebaseConfirmDialog`, not an extension of it.
 * That one's preview model is `GitRemoteOperationKind`, whose refs are always a
 * `GitPushDestination` — a remote plus a branch. A base target may be a purely
 * local branch in a repo with no remote at all, which that shape cannot
 * describe truthfully, and both of its kinds measure against the branch's OWN
 * upstream rather than the base. Sharing the shell and the vocabulary is what
 * keeps the family legible; sharing the data model would have needed nullable
 * fields that lie.
 *
 * Abort is confirmed here too. It reads the staging status rather than a commit
 * range, because what it discards is conflict work in progress — and it renders
 * the same sentence Review Hub's own abort confirm renders, from the same
 * builder, so the two surfaces cannot describe one operation two ways.
 */
function GitWorktreeOperationConfirmDialogInner() {
  const pendingConfirm = useGitWorktreeOperationConfirmStore((s) => s.pendingConfirm);
  const resolveConfirmation = useGitWorktreeOperationConfirmStore((s) => s.resolveConfirmation);

  // The store's monotonic counter, read as part of the read identity below.
  const requestSeq = useGitWorktreeOperationConfirmStore((s) => s.requestSeq);

  const request = pendingConfirm?.request ?? null;
  const cwd = request?.cwd ?? null;
  const kind = request?.kind ?? null;
  const baseBranch = request && request.kind !== "abort-operation" ? request.baseBranch : null;

  const [loaded, setLoaded] = useState<LoadedPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  /**
   * The request the currently-held read actually describes.
   *
   * Approval is gated on this matching the pending request, not merely on
   * "something loaded". The host stays mounted across close/open and only
   * returns null, so without this a second confirm for a DIFFERENT worktree
   * renders the previous worktree's branch, ref and commits — with the primary
   * enabled against them — for the frames between render and effect. In a
   * window holding a dozen worktrees whose branches are all called something
   * like `main`, nothing on screen would give that away.
   */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  // Identity of the READ, and therefore of what may be approved.
  //
  // `requestSeq` is the load-bearing part. Keying on `{kind, baseBranch, cwd}`
  // alone looked sufficient and was not: two consecutive requests with those
  // three identical — the same row clicked twice, or an agent re-dispatching —
  // produce an unchanged key, so no effect reruns and the SECOND request can be
  // approved against the FIRST one's commits. The counter changes on every
  // request by construction, which is exactly the property needed here.
  const previewKey = cwd && kind ? [requestSeq, kind, baseBranch ?? "", cwd].join(KEY_SEP) : null;

  const loadPreview = useCallback(() => {
    if (!cwd || !kind || !previewKey) return;
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setLoadError(null);
    setLoaded(null);
    setLoadedFor(null);

    const read: Promise<LoadedPayload> =
      kind === "abort-operation"
        ? window.electron.git
            .getStagingStatus(cwd)
            .then((status) => ({ kind: "abort-operation" as const, status }))
        : window.electron.git
            .listBaseIntegrationCommits(cwd, baseBranch ?? "", kind, PREVIEW_COMMIT_LIMIT)
            .then((preview) => ({ kind: "base-integration" as const, preview }));

    safeFireAndForget(
      read
        .then((result) => {
          if (requestIdRef.current !== requestId) return;
          setLoaded(result);
          setLoadedFor(previewKey);
        })
        .catch((err: unknown) => {
          if (requestIdRef.current !== requestId) return;
          // The handler fails as a `GitOperationError`, and the preload carries
          // its discriminant across the realm boundary encoded INTO the message
          // (`[GitError|<reason>||<branch>] fatal: …`). The guard strips that
          // prefix in place and is idempotent, so format AFTER calling it or
          // the dialog shows the user the encoding.
          isClientGitError(err);
          setLoadError(formatErrorMessage(err, "Git ended the read without saying why."));
        })
        .finally(() => {
          if (requestIdRef.current !== requestId) return;
          setIsLoading(false);
        }),
      { context: "GitWorktreeOperationConfirmDialog: load confirm preview" }
    );
  }, [cwd, kind, baseBranch, previewKey]);

  useEffect(() => {
    if (!previewKey) {
      // Bumped, not just cleared: a read already in flight when the dialog
      // closes would otherwise land its `.then` and repopulate state while
      // hidden, ready to be shown to whatever asks next.
      requestIdRef.current++;
      setLoaded(null);
      setLoadedFor(null);
      setLoadError(null);
      setIsLoading(false);
      return;
    }
    loadPreview();
  }, [previewKey, loadPreview]);

  // The skeleton's 400ms gate lives in `animate-pulse-delayed`'s own
  // animation-delay, so it is free. The footer hint is plain text and has no
  // gate of its own, which would otherwise put a "checking…" line on screen for
  // reads that resolve before the bones ever become visible.
  const showPendingHint = useDeferredLoading(isLoading, UI_DOHERTY_THRESHOLD);

  // Resolve false on unmount to prevent a leaked awaited Promise.
  useEffect(() => {
    return () => {
      if (useGitWorktreeOperationConfirmStore.getState().pendingConfirm) {
        useGitWorktreeOperationConfirmStore.getState().resolveConfirmation(false);
      }
    };
  }, []);

  if (!request) return null;

  // Settled means "this request's own fresh answer is on screen". `isLoading`
  // starts false and the read only begins in an effect, so a check that asked
  // merely whether loading had finished would classify the first painted frame
  // as loaded and enable the primary against nothing.
  const isSettled = !isLoading && !loadError && loadedFor === previewKey;

  if (request.kind === "abort-operation") {
    const status = isSettled && loaded?.kind === "abort-operation" ? loaded.status : null;
    // Re-derived from a fresh read rather than trusted from the request: the
    // request was built from the card's polled snapshot, and an operation can
    // finish — or be replaced by a different one — between the menu opening and
    // the confirm resolving.
    //
    // The fresh state feeds BOTH the label and the consequence sentence. Taking
    // the label from the read and the sentence from the request would let the
    // dialog say "Abort merge?" over a rebase's consequences.
    const freshOperation = status ? toRepoOperationState(status.repoState) : null;
    const operation = freshOperation ?? request.operation;
    const label = OPERATION_LABEL[operation].toLowerCase();
    // Nothing to abort. The handler refuses this anyway ("No merge, rebase,
    // cherry-pick, or revert operation is in progress"), and a live primary
    // over a settled read that found no operation is an approval the surface
    // cannot honour.
    const nothingInProgress = status !== null && freshOperation === null;
    return (
      <ConfirmDialog
        isOpen={true}
        onClose={() => resolveConfirmation(false)}
        title={nothingInProgress ? "Nothing to abort" : `Abort ${label}?`}
        description={
          nothingInProgress
            ? "This worktree is no longer mid-operation — it finished or was already resolved."
            : status && freshOperation
              ? buildAbortDescription(freshOperation, status)
              : loadError
                ? `Couldn't read what this would discard. Aborting still ends the in-progress ${label}.`
                : `Discards the in-progress ${label}.`
        }
        confirmLabel={nothingInProgress ? "Close" : `Abort ${label}`}
        cancelLabel="Keep working"
        variant="destructive"
        // Held until this request's own read settles: the counts in the
        // description are the whole reason to confirm, and approving before
        // they land is approving a blank.
        confirmDisabled={nothingInProgress || (!isSettled && !loadError)}
        hint={
          !isSettled && !loadError && showPendingHint ? "Checking what this would discard…" : null
        }
        onConfirm={() => resolveConfirmation(!nothingInProgress)}
      />
    );
  }

  const copy = COPY[request.kind];
  const preview = loaded?.kind === "base-integration" ? loaded.preview : null;
  const commits = preview?.commits ?? null;
  const isLoaded = isSettled && preview !== null;
  const total = preview?.total ?? 0;
  const behind = preview?.behind ?? 0;
  const compareRef = preview?.compareRef ?? null;
  const branch = preview?.branch ?? null;

  // "Nothing to do" is `behind === 0` for BOTH kinds, and deliberately not
  // `commits.length === 0`. `behind` counts what the base has that this branch
  // does not, which is exactly what either operation brings across.
  //
  // An empty `commits` is a different statement, and only for the rebase kind:
  // the replay set is measured `--no-merges --cherry-pick --right-only`, so a
  // branch carrying merge commits, or commits the base already holds as
  // equivalent patches, measures empty while the rebase still moves it onto the
  // base. Reading that as "up to date" would disable the primary on an
  // operation that does something.
  const isNothingToDo = isLoaded && behind === 0;
  const isBehindWithNothingToReplay =
    isLoaded && request.kind === "rebase-onto-base" && commits?.length === 0 && behind > 0;

  // A base ref nobody can name can't be approved — the handler refuses the
  // operation anyway, and guessing `origin` is the bug (#11746). The read fails
  // CLOSED on that case, so an unresolvable ref arrives here as `loadError`
  // rather than as a loaded preview; the `isSettled` half is what stops an
  // unsettled or failed read from being approved.
  const confirmDisabled = !isSettled || preview === null || isNothingToDo;

  // Names the one unmet prerequisite rather than leaving a dead button to be
  // read as arbitrary. Ordered by which the user can act on first.
  const blockedReason = loadError
    ? "Retry the preview to continue"
    : isNothingToDo
      ? "Already up to date with the base branch"
      : showPendingHint
        ? "Checking what this would change…"
        : null;

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => resolveConfirmation(false)}
      title={copy.title}
      description={<span>{copy.description}</span>}
      confirmLabel={copy.confirmLabel}
      cancelLabel="Cancel"
      variant="destructive"
      hasPreview={true}
      // Deliberately NOT `isConfirmLoading`. That prop means "the confirmed
      // action is running": it overlays a spinner on the primary and disables
      // Cancel. A preview fetch is not a reason to take away the way out.
      confirmDisabled={confirmDisabled}
      hint={blockedReason}
      // Hands back the two commits this panel actually described. The handler
      // refuses if either has moved, so what gets rebased is what was read here
      // — not whatever the refs point at by the time the click lands.
      onConfirm={() =>
        resolveConfirmation(true, {
          ...(preview?.branch ? { branch: preview.branch } : {}),
          ...(preview?.headOid ? { headOid: preview.headOid } : {}),
          ...(preview?.baseOid ? { baseOid: preview.baseOid } : {}),
        })
      }
    >
      <PreviewFrame>
        {loadError && (
          <PreviewNotice
            tone="error"
            title={copy.readFailure}
            onRetry={loadPreview}
            retryTestId="git-base-integration-retry"
          >
            {loadError}
          </PreviewNotice>
        )}
        {/* Subject first, then target: the pair reads in the order the
            operation happens. Same local-then-base order for both kinds, with
            the labels carrying the direction — Rewrites/Onto for a replay,
            Into/From for an integration. */}
        <PreviewSummary testId="git-base-integration-summary">
          <SummaryRow label={copy.subjectLabel}>
            {branch && isSettled ? (
              <RefChip value={branch} />
            ) : !isSettled && !loadError ? (
              <Bone className="w-40" />
            ) : (
              <MissingValue />
            )}
          </SummaryRow>
          <SummaryRow label={copy.targetLabel}>
            {compareRef && isSettled ? (
              <RefChip value={compareRef} />
            ) : !isSettled && !loadError ? (
              <Bone className="w-48" />
            ) : (
              <MissingValue />
            )}
          </SummaryRow>
        </PreviewSummary>

        {!isSettled && !loadError && (
          <PreviewSkeleton label={copy.loadingLabel} testId="git-base-integration-loading" />
        )}

        {isNothingToDo && (
          <PreviewNote testId="git-base-integration-in-sync">
            Nothing to do &mdash; {branch} already has everything on {compareRef}.
          </PreviewNote>
        )}

        {isLoaded && !isNothingToDo && (
          <PreviewSectionHeading label={copy.commitsHeading} count={total} />
        )}

        {isBehindWithNothingToReplay && (
          <PreviewNote testId="git-base-integration-nothing-to-replay">
            {branch} is {behind} behind {compareRef} and has no commit the rebase would replay on
            top of it &mdash; the branch moves, nothing is rewritten.
          </PreviewNote>
        )}

        {isLoaded && !isNothingToDo && commits !== null && commits.length > 0 && (
          <CommitRows
            commits={commits}
            total={total}
            label={`${copy.commitsHeading}${compareRef ? ` — ${compareRef}` : ""}`}
            rowTestId="git-base-integration-commit-row"
          />
        )}
      </PreviewFrame>
      {/* Gated on there actually being something to integrate: a caution about
          conflicts under a panel that has just said nothing would move is the
          same contradiction it exists to avoid. */}
      {isLoaded && !isNothingToDo && (
        <p className="text-2xs text-text-secondary">{copy.footnote}</p>
      )}
    </ConfirmDialog>
  );
}

export function GitWorktreeOperationConfirmDialog() {
  // Reset the boundary on each new request so a crashed inner dialog recovers
  // when the next confirm arrives (#9918). Without a changing key, an inner
  // render crash leaves this boundary stuck for the session.
  const requestSeq = useGitWorktreeOperationConfirmStore((s) => s.requestSeq);
  return (
    <ErrorBoundary
      variant="component"
      componentName="GitWorktreeOperationConfirmDialog"
      resetKeys={[requestSeq]}
    >
      <GitWorktreeOperationConfirmDialogInner />
    </ErrorBoundary>
  );
}
