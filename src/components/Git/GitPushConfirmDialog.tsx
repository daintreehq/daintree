import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Button } from "@/components/ui/button";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import {
  buildGitRemoteOperationPreview,
  formatGitPushDestination,
  type GitPreviewCommit,
  type GitPushRangeFacts,
} from "@/components/Git/gitRemoteOperationPreview";
import type { GitPushDestination } from "@shared/types/git";

const SHORT_HASH_LEN = 7;

/** Rows the skeleton draws. Enough to hold the panel's height without claiming a count. */
const SKELETON_ROWS = 3;

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

  const [branch, setBranch] = useState<string | null>(null);
  const [destination, setDestination] = useState<GitPushDestination | null>(null);
  const [commits, setCommits] = useState<GitPreviewCommit[] | null>(null);
  const [pushRange, setPushRange] = useState<GitPushRangeFacts | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const requestIdRef = useRef(0);

  const loadPreview = useCallback(() => {
    if (!cwd) return;
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setLoadError(null);
    setBranch(null);
    setDestination(null);
    setCommits(null);
    setPushRange(null);

    safeFireAndForget(
      // Shared with the MCP confirm surface so agent and human approvers see
      // the identical fresh destination and publish range (#11538).
      buildGitRemoteOperationPreview(cwd, "push")
        .then((preview) => {
          if (requestIdRef.current !== requestId) return;
          setBranch(preview.branch);
          setDestination(preview.destination);
          setCommits(preview.commits);
          setPushRange(preview.pushRange);
        })
        .catch((err: unknown) => {
          if (requestIdRef.current !== requestId) return;
          setLoadError(formatErrorMessage(err, "Failed to load push preview"));
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
      setBranch(null);
      setDestination(null);
      setCommits(null);
      setPushRange(null);
      setLoadError(null);
      setIsLoading(false);
      return;
    }
    loadPreview();
  }, [cwd, loadPreview]);

  // Resolve false on unmount to prevent a leaked awaited Promise.
  useEffect(() => {
    return () => {
      if (useGitPushConfirmStore.getState().pendingConfirm) {
        useGitPushConfirmStore.getState().resolveConfirmation(false);
      }
    };
  }, []);

  if (!pendingConfirm) return null;

  const destinationLabel = destination ? formatGitPushDestination(destination) : null;
  const isDestinationMissing = !isLoading && !loadError && destination === null;
  const isLoaded = !isLoading && !loadError && commits !== null;
  const isInSync = isLoaded && commits.length === 0 && destination !== null;
  const total = pushRange?.total ?? commits?.length ?? 0;
  const hiddenCount = commits ? Math.max(0, total - commits.length) : 0;

  // A destination nobody can name can't be approved — the handler would refuse
  // the write anyway, and guessing `origin` is the bug (#11746). `commits === null`
  // is "not loaded", which is a different thing from a loaded empty range: an
  // in-sync branch is approvable and pushes nothing (#9575).
  const confirmDisabled = commits === null || !destination || !!loadError;

  // Names the one unmet prerequisite rather than leaving a dead button to be
  // read as arbitrary. Ordered by which the user can act on first.
  const blockedReason = loadError
    ? "Push stays blocked until the preview loads"
    : isDestinationMissing
      ? "Push stays blocked until a destination is set"
      : isLoading
        ? "Checking what this would publish…"
        : null;

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => resolveConfirmation(false)}
      title="Push commits?"
      description={
        <span>
          Publishing puts these commits on the remote, where everyone working from it sees them.
          Taking them back afterwards needs a force-push.
        </span>
      }
      confirmLabel="Push"
      cancelLabel="Cancel"
      variant="destructive"
      hasPreview={true}
      // Deliberately NOT `isConfirmLoading={isLoading}`. That prop means "the
      // confirmed action is running": it overlays a spinner on the primary,
      // dims its label to 30%, and disables Cancel. Wiring the PREVIEW fetch to
      // it drew a spinner across the word "Push", and — because AppDialog's
      // initial-focus pass finds the Cancel button by selector and calls
      // `.focus()` on it without checking it is enabled — left focus outside
      // the dialog entirely for the whole fetch.
      confirmDisabled={confirmDisabled}
      hint={blockedReason}
      onConfirm={() => resolveConfirmation(true)}
    >
      <div className="rounded border border-tint/[0.08] bg-tint/[0.04] text-xs">
        <dl className="px-3 py-2 space-y-1.5" data-testid="git-push-destination-summary">
          <SummaryRow label="From">
            {branch ? (
              <RefChip value={branch} />
            ) : isLoading ? (
              <Bone className="w-40" />
            ) : (
              <Unresolved />
            )}
          </SummaryRow>
          <SummaryRow label="To">
            {destinationLabel ? (
              <span className="flex flex-wrap items-baseline gap-1.5">
                <RefChip value={destinationLabel} emphasis />
                {pushRange?.createsRemoteBranch && (
                  <span className="text-[10px] text-daintree-text/55">creates this branch</span>
                )}
              </span>
            ) : isLoading ? (
              <Bone className="w-48" />
            ) : (
              <Unresolved />
            )}
          </SummaryRow>
        </dl>

        <div className="px-3 py-2 border-y border-tint/[0.08] flex items-center justify-between gap-2">
          <span
            role="heading"
            aria-level={3}
            className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60"
          >
            Commits to push
            {isLoaded && total > 0 && (
              <span className="ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal">
                {total}
              </span>
            )}
          </span>
        </div>

        {isLoading && (
          <ul
            className="px-3 py-2 space-y-1.5"
            data-testid="git-push-commits-loading"
            aria-hidden="true"
          >
            {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <Bone className="w-[3.5rem]" />
                <Bone className={i === 1 ? "w-40" : "w-52"} />
                <Bone className="w-16 ml-auto" />
              </li>
            ))}
          </ul>
        )}

        {!isLoading && loadError && (
          <div className="px-3 py-3 text-status-error flex items-start gap-2" role="alert">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium">Couldn&apos;t read what this would publish</div>
              <div className="mt-0.5 text-daintree-text/70 break-words">{loadError}</div>
              <Button
                variant="ghost-danger"
                size="sm"
                onClick={loadPreview}
                data-testid="git-push-commits-retry"
                className="mt-1.5 h-6 px-2 text-[11px]"
              >
                <RefreshCw className="w-3 h-3" />
                Retry
              </Button>
            </div>
          </div>
        )}

        {isDestinationMissing && (
          <div className="px-3 py-3 text-status-error flex items-start gap-2" role="alert">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0" data-testid="git-push-no-destination">
              <div className="font-medium">No destination git can name</div>
              <div className="mt-0.5 text-daintree-text/70">
                This branch has no push destination, or more than one remote could be meant. Set an
                upstream, or name one with{" "}
                <span className="font-mono break-all">
                  git config branch.&lt;name&gt;.pushRemote
                </span>
                .
              </div>
            </div>
          </div>
        )}

        {isInSync && (
          <div className="px-3 py-3 text-daintree-text/60" data-testid="git-push-in-sync">
            Nothing to publish &mdash; {destinationLabel} already has everything on this branch.
          </div>
        )}

        {isLoaded && commits.length > 0 && (
          // A scrollable region with no focusable children of its own has to be
          // reachable by keyboard in its own right (WCAG 2.1.1), and the fades
          // are what say "there is more" — a row clipped by the panel edge was
          // the only previous cue, and a clip that happens to land on a row
          // boundary says the opposite.
          <ScrollShadow
            className="max-h-[180px]"
            scrollClassName="scroll-py-8"
            tabIndex={0}
            role="region"
            aria-label={`Commits to push${destinationLabel ? ` to ${destinationLabel}` : ""}`}
          >
            <ul className="px-3 py-2 space-y-1.5">
              {commits.map((commit) => (
                <li
                  key={commit.hash}
                  className="flex items-baseline gap-2"
                  data-testid="git-push-commit-row"
                >
                  <span className="font-mono text-[11px] text-daintree-text/55 shrink-0 tabular-nums">
                    {commit.hash.slice(0, SHORT_HASH_LEN)}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-daintree-text/90">
                    {commit.message}
                  </span>
                  {/* Bounded, unlike the rest of the row: an author is the least
                    important column here, and left unbounded a long name took
                    40% of the width and truncated the subject to nothing. */}
                  <span className="text-[11px] text-daintree-text/55 shrink-0 max-w-[7rem] truncate">
                    {commit.author}
                  </span>
                </li>
              ))}
              {hiddenCount > 0 && (
                <li className="text-[11px] text-daintree-text/55 italic pt-0.5">
                  &hellip;and {hiddenCount} more
                </li>
              )}
            </ul>
          </ScrollShadow>
        )}
      </div>
    </ConfirmDialog>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-[10px] uppercase tracking-wider text-daintree-text/55 shrink-0 w-10">
        {label}
      </dt>
      <dd className="flex-1 min-w-0">{children}</dd>
    </div>
  );
}

/**
 * A ref as a value rather than a word in a sentence.
 *
 * `break-all` rather than truncation: a push destination is the one fact on this
 * surface that must never be shortened, and a 90-character fork ref wrapping
 * across three lines is a better outcome than an ellipsis in the middle of the
 * repository name being written to.
 */
function RefChip({ value, emphasis }: { value: string; emphasis?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline px-1.5 py-0.5 rounded bg-tint/[0.07] border border-tint/[0.08] text-[11px] font-mono break-all",
        emphasis ? "text-daintree-text" : "text-daintree-text/70"
      )}
    >
      {value}
    </span>
  );
}

function Unresolved() {
  return <span className="text-status-error text-[11px]">Not resolved</span>;
}

/**
 * Skeleton bone. `animate-pulse-delayed` carries the 400ms Doherty gate in its
 * own `animation-delay`, so a fetch that returns quickly paints nothing at all.
 */
function Bone({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block h-3.5 rounded bg-tint/[0.08] animate-pulse-delayed", className)}
    />
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
