import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  CommitRows,
  PreviewFrame,
  PreviewNote,
  PreviewNotice,
  PreviewSectionHeading,
  PreviewSkeleton,
} from "@/components/Git/GitOperationPreview";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { GIT_REMOTE_COMMIT_PREVIEW_MAX, type GitRemoteCommitPreview } from "@shared/types/git";
import { formatGitPushDestination } from "@/components/Git/gitRemoteOperationPreview";
import { useGitForcePushStore } from "@/store/gitForcePushStore";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";

/**
 * Ask for everything the handler will serve. It used to ask for 20 and print
 * "…and N more" for the rest — a count, on the one dialog where D2 says a count
 * is not enough, naming commits nothing could open (#12001).
 */
const COMMIT_LIMIT = GIT_REMOTE_COMMIT_PREVIEW_MAX;

/**
 * D2 confirm for `git.forcePushWithLease`, mounted globally and driven by
 * `gitForcePushStore` — the same deferred-Promise shape as
 * `GitPushConfirmDialog` and `GitPullRebaseConfirmDialog`.
 *
 * It confirms; it does not push. The action's `run()` owns the IPC so its
 * dispatch result reports the real outcome, and so the one place that reads a
 * lease is the one place that was handed it.
 *
 * The lease is shown in full rather than abbreviated. Everything else in this
 * dialog is a preview of what would be discarded; the lease is the thing that
 * decides whether the discard is allowed to happen at all, and a seven-character
 * prefix of it is not something a user can check against anything.
 */
function GitForcePushConfirmDialogInner() {
  const pendingConfirm = useGitForcePushStore((s) => s.pendingConfirm);
  const resolveConfirmation = useGitForcePushStore((s) => s.resolveConfirmation);

  const record = pendingConfirm?.record ?? null;
  const requestId = pendingConfirm?.requestId ?? null;
  const cwd = record?.cwd ?? null;
  const branchName = record?.branchName ?? null;
  const leaseSha = record?.leaseSha ?? null;
  const generation = record?.generation ?? null;

  const [preview, setPreview] = useState<GitRemoteCommitPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  /**
   * The generation the held preview actually describes. Approval is gated on
   * this matching the pending record, not merely on "something loaded": the
   * host stays mounted across close/open, so without it a second request for a
   * DIFFERENT worktree renders the previous one's commits — with Force push
   * enabled against them — for the frames between render and effect.
   */
  const [previewGeneration, setPreviewGeneration] = useState<number | null>(null);
  const fetchIdRef = useRef(0);
  /**
   * The request this instance last rendered. Unmount cleanup settles only that
   * one: a tokenless decline would cancel whatever request happened to be
   * pending, including a newer one installed while this instance was tearing
   * down (an ErrorBoundary remount is exactly that shape).
   */
  const renderedRequestIdRef = useRef<number | null>(null);
  const declineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadCommits = useCallback(() => {
    if (cwd === null || branchName === null || generation === null) return;
    const requestId = ++fetchIdRef.current;
    setIsLoading(true);
    setLoadError(null);
    setPreview(null);
    setPreviewGeneration(null);

    safeFireAndForget(
      window.electron.git
        .listRemoteCommits(cwd, branchName, COMMIT_LIMIT)
        .then((result) => {
          if (fetchIdRef.current !== requestId) return;
          setPreview(result);
          setPreviewGeneration(generation);
        })
        .catch((err: unknown) => {
          if (fetchIdRef.current !== requestId) return;
          setLoadError(formatErrorMessage(err, "Failed to load remote commits"));
        })
        .finally(() => {
          if (fetchIdRef.current !== requestId) return;
          setIsLoading(false);
        }),
      { context: "GitForcePushConfirmDialog: load remote commits" }
    );
  }, [cwd, branchName, generation]);

  useEffect(() => {
    if (record === null) {
      // Invalidate anything still in flight so a late response can't repopulate
      // the preview after the request it belonged to went away.
      fetchIdRef.current++;
      setPreview(null);
      setPreviewGeneration(null);
      setLoadError(null);
      setIsLoading(false);
      return;
    }
    loadCommits();
  }, [record, loadCommits]);

  const commits = preview?.commits ?? null;
  // Both the rows and the total come from the same `HEAD..<push ref>` range, so
  // the tail can't be computed against a different repository's ref (#11746).
  const totalRemote = preview?.total ?? 0;
  // `git log` and the range count are two reads over a symbolic range, so a
  // concurrent fetch or branch move can leave them disagreeing. When it does,
  // neither is trustworthy — the rows may name commits the range no longer
  // holds, and the total may describe a range the rows don't. Picking one would
  // be guessing about what a force push discards, so the preview reloads
  // instead. Same fail-closed footing as a preview that never arrived.
  const isPreviewStale =
    (commits !== null && totalRemote < commits.length) ||
    (previewGeneration !== null && previewGeneration !== generation);
  // Optional-chained rather than keyed off `preview` alone: this crosses the
  // IPC boundary, so a payload missing the field must degrade to the branch
  // name rather than throwing inside a destructive confirm.
  // One blocking message for both shapes: a preview that failed to load and one
  // that arrived self-contradictory leave the user equally unable to see what
  // would be discarded, and both recover the same way.
  const blockingMessage =
    loadError ??
    (isPreviewStale
      ? "This preview went stale while loading — reload it before force pushing"
      : null);
  const destinationLabel = preview?.destination
    ? formatGitPushDestination(preview.destination)
    : null;

  const isBlocked = isLoading || !!loadError || preview === null || isPreviewStale;
  // Gated like the siblings' hint, so a read that lands inside the Doherty
  // window never flashes a "checking" line the skeleton itself didn't show.
  const showPendingHint = useDeferredLoading(isLoading, UI_DOHERTY_THRESHOLD);

  // Resolve false on teardown so the action's awaited Promise cannot leak — the
  // guarantee `GitPushConfirmDialog` gives, scoped to this request and deferred
  // by a tick.
  //
  // The deferral is what makes it survive an effect REPLAY. StrictMode runs
  // setup → cleanup → setup in one commit, and the host also remounts when its
  // ErrorBoundary resets after a crash — in both, a cleanup that declined
  // immediately would cancel a request still on screen. Only a real teardown
  // leaves the rescheduling setup un-run, so only a real teardown declines.
  // No dependency array on purpose: every commit re-arms the cancellation.
  useEffect(() => {
    renderedRequestIdRef.current = requestId;
    if (declineTimerRef.current !== null) {
      clearTimeout(declineTimerRef.current);
      declineTimerRef.current = null;
    }
    return () => {
      const owned = renderedRequestIdRef.current;
      if (owned === null) return;
      declineTimerRef.current = setTimeout(() => {
        declineTimerRef.current = null;
        useGitForcePushStore.getState().resolveConfirmation(owned, false);
      }, 0);
    };
  });

  const handleConfirm = () => {
    // Block confirm when the discard preview failed to load — without it the
    // user has no visibility into what `--force-with-lease` would discard,
    // even though the lease itself still keeps the operation safe. `preview`
    // is checked too: on the first render after opening it is null while
    // `isLoading` is still false, so the two guards together are what close
    // the window on a click landing before the fetch starts.
    if (isBlocked) return;
    if (requestId === null) return;
    // Re-read rather than trusting the render this handler closed over. A
    // request installed between that render and this click owns the store now,
    // and it has its own preview the user has not seen.
    const live = useGitForcePushStore.getState().pendingConfirm;
    if (!live || live.requestId !== requestId) return;
    if (previewGeneration !== live.record.generation) return;
    resolveConfirmation(requestId, true);
  };

  if (record === null || requestId === null || branchName === null || leaseSha === null) {
    return null;
  }

  return (
    <ConfirmDialog
      isOpen={true}
      // Fixed for the life of the request, like the push and pull-rebase titles
      // (#11979): it used to switch from the branch to the destination once the
      // preview landed, changing the dialog's accessible name mid-read. The
      // branch is known from the record before anything loads; the destination
      // is named in the body.
      title={`Force push ${branchName}?`}
      onClose={() => resolveConfirmation(requestId, false)}
      onConfirm={handleConfirm}
      confirmLabel="Force push"
      cancelLabel="Cancel"
      variant="destructive"
      hasPreview={true}
      confirmDisabled={isBlocked}
      // Names why the primary is unavailable, the same way the push and
      // pull-rebase confirms do.
      hint={
        !isLoading && blockingMessage
          ? "Retry the preview to continue"
          : showPendingHint
            ? "Checking what this would discard…"
            : null
      }
    >
      <div className="space-y-3 text-xs text-text-primary">
        <p>
          This rewrites <span className="font-mono">{destinationLabel ?? branchName}</span> to match
          your local branch <span className="font-mono">{branchName}</span>. Any commits on the
          remote that aren&apos;t in your local history will be discarded.
        </p>

        <p className="text-text-secondary">
          It proceeds only while the remote is still at{" "}
          <span className="font-mono break-all text-text-primary" data-testid="force-push-lease">
            {leaseSha}
          </span>
          , the commit your last push was rejected against. If anyone has pushed since, git refuses
          instead of overwriting them.
        </p>

        <PreviewFrame>
          {!isLoading && blockingMessage && (
            <PreviewNotice
              tone="error"
              title="Couldn't read what this would discard"
              onRetry={loadCommits}
              retryTestId="force-push-commits-retry"
            >
              {blockingMessage}
            </PreviewNotice>
          )}

          <PreviewSectionHeading label="Remote commits to discard" count={totalRemote} />

          {isLoading && (
            <PreviewSkeleton
              label="Checking what this would discard"
              testId="force-push-commits-loading"
            />
          )}

          {!isLoading && !blockingMessage && commits && commits.length === 0 && (
            <PreviewNote>
              No remote commits to discard. The remote may already match your local branch.
            </PreviewNote>
          )}

          {!isLoading && !blockingMessage && commits && commits.length > 0 && (
            <CommitRows
              commits={commits}
              total={totalRemote}
              label={`Remote commits to discard${destinationLabel ? ` from ${destinationLabel}` : ""}`}
              rowTestId="force-push-commit-row"
              capTestId="force-push-commit-cap"
            />
          )}
        </PreviewFrame>
      </div>
    </ConfirmDialog>
  );
}

export function GitForcePushConfirmDialog() {
  // Reset the boundary on each new request so a crashed inner dialog recovers
  // when the next force-push confirm arrives (#9918). Without a changing key,
  // an inner render crash leaves this boundary stuck for the session.
  const requestSeq = useGitForcePushStore((s) => s.requestSeq);
  return (
    <ErrorBoundary
      variant="component"
      componentName="GitForcePushConfirmDialog"
      resetKeys={[requestSeq]}
    >
      <GitForcePushConfirmDialogInner />
    </ErrorBoundary>
  );
}
