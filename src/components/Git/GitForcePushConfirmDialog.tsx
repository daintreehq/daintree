import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { Spinner } from "@/components/ui/Spinner";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { GIT_REMOTE_COMMIT_PREVIEW_MAX, type GitRemoteCommitPreview } from "@shared/types/git";
import { formatGitPushDestination } from "@/components/Git/gitRemoteOperationPreview";
import { useGitForcePushStore } from "@/store/gitForcePushStore";

/**
 * Ask for everything the handler will serve. It used to ask for 20 and print
 * "…and N more" for the rest — a count, on the one dialog where D2 says a count
 * is not enough, naming commits nothing could open (#12001).
 */
const COMMIT_LIMIT = GIT_REMOTE_COMMIT_PREVIEW_MAX;
const SHORT_HASH_LEN = 7;

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
  const hiddenCount =
    commits !== null && totalRemote > commits.length ? totalRemote - commits.length : 0;
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
      title={destinationLabel ? `Force push to ${destinationLabel}?` : `Force push ${branchName}?`}
      onClose={() => resolveConfirmation(requestId, false)}
      onConfirm={handleConfirm}
      confirmLabel="Force push"
      cancelLabel="Cancel"
      variant="destructive"
      hasPreview={true}
      confirmDisabled={isBlocked}
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

        <div className="rounded border border-tint/[0.08] bg-tint/[0.04]">
          <div className="px-3 py-2 border-b border-tint/[0.08] flex items-center justify-between">
            <span className="text-2xs font-semibold uppercase tracking-wider text-text-secondary">
              Remote commits to discard
              {totalRemote > 0 && (
                <span className="ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-3xs font-medium normal-case tracking-normal">
                  {totalRemote}
                </span>
              )}
            </span>
          </div>

          {isLoading && (
            <div
              className="flex items-center justify-center py-6"
              data-testid="force-push-commits-loading"
            >
              <Spinner size="sm" className="text-daintree-text/40" />
            </div>
          )}

          {!isLoading && blockingMessage && (
            <div className="px-3 py-3 text-status-error flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div>{blockingMessage}</div>
                <button
                  type="button"
                  onClick={loadCommits}
                  data-testid="force-push-commits-retry"
                  className={cn(
                    "mt-1 inline-flex items-center px-2 py-0.5 rounded text-2xs font-medium transition-colors",
                    "bg-status-error/15 hover:bg-status-error/25 text-status-error",
                    "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-status-error"
                  )}
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {!isLoading && !blockingMessage && commits && commits.length === 0 && (
            <div className="px-3 py-3 text-text-secondary">
              No remote commits to discard. The remote may already match your local branch.
            </div>
          )}

          {!isLoading && !blockingMessage && commits && commits.length > 0 && (
            // A scrollable region with no focusable children of its own has to
            // be reachable by keyboard in its own right (WCAG 2.1.1), and the
            // fades are what say "there is more" — the same shape
            // `GitPushConfirmDialog` uses for the identical problem.
            <ScrollShadow
              className="max-h-[180px]"
              scrollClassName="scroll-py-8"
              tabIndex={0}
              role="region"
              aria-label={`Remote commits to discard${
                destinationLabel ? ` from ${destinationLabel}` : ""
              }`}
            >
              <ul className="px-3 py-2 space-y-1.5">
                {commits.map((commit) => (
                  <li
                    key={commit.hash}
                    className="flex items-baseline gap-2"
                    data-testid="force-push-commit-row"
                  >
                    <span
                      className={cn("font-mono text-3xs text-text-secondary shrink-0 tabular-nums")}
                    >
                      {commit.hash.slice(0, SHORT_HASH_LEN)}
                    </span>
                    <span className="text-text-primary truncate min-w-0">{commit.message}</span>
                    <span className="text-3xs text-text-secondary shrink-0 ml-auto">
                      {commit.author}
                    </span>
                  </li>
                ))}
                {hiddenCount > 0 && (
                  // Past the fetch ceiling the tail states a fact rather than
                  // promising a list: at this magnitude what decides the answer
                  // is that the divergence runs to hundreds of commits, not
                  // what the hundred-and-first one says.
                  <li
                    className="text-3xs text-text-secondary italic pt-1"
                    data-testid="force-push-commit-cap"
                  >
                    Listing the {commits.length} most recent of {totalRemote}
                  </li>
                )}
              </ul>
            </ScrollShadow>
          )}
        </div>
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
