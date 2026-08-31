import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Button } from "@/components/ui/button";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Skeleton } from "@/components/ui/Skeleton";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { isClientGitError } from "@/utils/clientGitError";
import { useGitWorktreeOperationConfirmStore } from "@/store/gitWorktreeOperationConfirmStore";
import type { GitBaseIntegrationCommitPreview } from "@shared/types/git";
import type { StagingStatus } from "@shared/types";
import { OPERATION_LABEL, buildAbortDescription } from "@/components/Git/repoOperationCopy";

const SHORT_HASH_LEN = 7;

/** Max commits fetched and shown before the tail is collapsed. */
const PREVIEW_COMMIT_LIMIT = 12;

/** Rows the skeleton draws. Enough to hold the panel's height without claiming a count. */
const SKELETON_ROWS = 3;

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

/** Separator for the request identity key; illegal in a path and in a git ref. */
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

  // Identity of the thing being read. The worktree alone is not enough: the
  // same worktree can be asked about a rebase and then a merge, and those are
  // different commit sets under one cwd.
  const previewKey = cwd && kind ? [kind, baseBranch ?? "", cwd].join(KEY_SEP) : null;

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
    // finish between the menu opening and the confirm resolving.
    const freshOperation = status ? toOperationLabel(status) : null;
    const label = (freshOperation ?? OPERATION_LABEL[request.operation]).toLowerCase();
    return (
      <ConfirmDialog
        isOpen={true}
        onClose={() => resolveConfirmation(false)}
        title={`Abort ${label}?`}
        description={
          status && freshOperation
            ? buildAbortDescription(request.operation, status)
            : loadError
              ? `Couldn't read what this would discard. Aborting still ends the in-progress ${label}.`
              : `Discards the in-progress ${label}.`
        }
        confirmLabel={`Abort ${label}`}
        cancelLabel="Keep working"
        variant="destructive"
        onConfirm={() => resolveConfirmation(true)}
      />
    );
  }

  const copy = COPY[request.kind];
  const preview = loaded?.kind === "base-integration" ? loaded.preview : null;
  const commits = preview?.commits ?? null;
  const isLoaded = isSettled && preview !== null;
  const total = preview?.total ?? 0;
  const behind = preview?.behind ?? 0;
  const hiddenCount = commits ? Math.max(0, total - commits.length) : 0;
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
      onConfirm={() => resolveConfirmation(true)}
    >
      <div className="rounded border border-tint/[0.08] bg-tint/[0.04] text-xs">
        {/* Subject first, then target: the pair reads in the order the
            operation happens. Same local-then-base order for both kinds, with
            the labels carrying the direction — Rewrites/Onto for a replay,
            Into/From for an integration. */}
        <dl className="px-3 py-2 space-y-1.5" data-testid="git-base-integration-summary">
          <SummaryRow label={copy.subjectLabel}>
            {branch && isSettled ? (
              <RefChip value={branch} emphasis />
            ) : !isSettled && !loadError ? (
              <Bone className="w-40" />
            ) : (
              <Unknown />
            )}
          </SummaryRow>
          <SummaryRow label={copy.targetLabel}>
            {compareRef && isSettled ? (
              <RefChip value={compareRef} emphasis />
            ) : !isSettled && !loadError ? (
              <Bone className="w-48" />
            ) : (
              <Unknown />
            )}
          </SummaryRow>
        </dl>

        <div className="px-3 py-2 border-y border-tint/[0.08] flex items-center justify-between gap-2">
          <span
            role="heading"
            aria-level={3}
            className="text-2xs font-semibold uppercase tracking-wider text-text-secondary"
          >
            {copy.commitsHeading}
            {isSettled && total > 0 && (
              <span className="ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-3xs font-medium normal-case tracking-normal">
                {total}
              </span>
            )}
          </span>
        </div>

        {!isSettled && !loadError && (
          // `Skeleton` is what makes this reach a screen reader: the bones alone
          // are decorative, so a blocked primary with no announced busy state
          // leaves an AT user with a dead button and no explanation.
          <Skeleton label={copy.loadingLabel} data-testid="git-base-integration-loading">
            <ul className="px-3 py-2 space-y-1.5">
              {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
                <li key={i} className="flex items-baseline gap-2">
                  <Bone className="w-[3.5rem]" />
                  <Bone className={i === 1 ? "w-40" : "w-52"} />
                  <Bone className="w-16 ml-auto" />
                </li>
              ))}
            </ul>
          </Skeleton>
        )}

        {!isLoading && loadError && (
          <div className="px-3 py-3 text-status-error flex items-start gap-2" role="alert">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium">{copy.readFailure}</div>
              <div className="mt-0.5 text-text-secondary break-words">{loadError}</div>
              <Button
                variant="ghost-danger"
                size="sm"
                onClick={loadPreview}
                data-testid="git-base-integration-retry"
                className="mt-1.5 h-6 px-2 text-2xs"
              >
                <RefreshCw className="w-3 h-3" />
                Retry
              </Button>
            </div>
          </div>
        )}

        {isNothingToDo && (
          <div className="px-3 py-3 text-text-secondary" data-testid="git-base-integration-in-sync">
            Nothing to do &mdash; {branch} already has everything on {compareRef}.
          </div>
        )}

        {isBehindWithNothingToReplay && (
          <div
            className="px-3 py-3 text-text-secondary"
            data-testid="git-base-integration-nothing-to-replay"
          >
            {branch} is {behind} behind {compareRef} and has no commit the rebase would replay on
            top of it &mdash; the branch moves, nothing is rewritten.
          </div>
        )}

        {isLoaded && commits !== null && commits.length > 0 && (
          // A scrollable region with no focusable children of its own has to be
          // reachable by keyboard in its own right (WCAG 2.1.1), and the fades
          // are what say "there is more".
          <ScrollShadow
            className="max-h-[180px]"
            scrollClassName="scroll-py-8"
            tabIndex={0}
            role="region"
            aria-label={`${copy.commitsHeading}${compareRef ? ` — ${compareRef}` : ""}`}
          >
            <ul className="px-3 py-2 space-y-1.5">
              {commits.map((commit) => (
                <li
                  key={commit.hash}
                  className="flex items-baseline gap-2"
                  data-testid="git-base-integration-commit-row"
                >
                  <span className="font-mono text-2xs text-text-secondary shrink-0 tabular-nums">
                    {commit.hash.slice(0, SHORT_HASH_LEN)}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-text-primary">
                    {commit.message}
                  </span>
                  {/* Bounded, unlike the rest of the row: an author is the least
                      important column here, and left unbounded a long name takes
                      45% of the width and truncates the subject. */}
                  <span className="text-2xs text-text-secondary shrink-0 max-w-[7rem] truncate">
                    {commit.author}
                  </span>
                </li>
              ))}
              {hiddenCount > 0 && (
                <li className="text-2xs text-text-secondary italic pt-0.5">
                  &hellip;and {hiddenCount} more
                </li>
              )}
            </ul>
          </ScrollShadow>
        )}
      </div>
      {/* Gated on there actually being something to integrate: a caution about
          conflicts under a panel that has just said nothing would move is the
          same contradiction it exists to avoid. */}
      {isLoaded && !isNothingToDo && (
        <p className="text-2xs text-text-secondary">{copy.footnote}</p>
      )}
    </ConfirmDialog>
  );
}

/**
 * The operation a fresh staging status says is in progress, or `null`.
 */
function toOperationLabel(status: StagingStatus): string | null {
  const state = status.repoState;
  if (state === "CLEAN" || state === "DIRTY") return null;
  return OPERATION_LABEL[state];
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-3xs uppercase tracking-wider text-text-secondary shrink-0 w-14">
        {label}
      </dt>
      <dd className="flex-1 min-w-0">{children}</dd>
    </div>
  );
}

/**
 * A ref as a value rather than a word in a sentence.
 *
 * `break-words` rather than truncation: the base ref is the one fact on this
 * surface that must never be shortened, and a long fork ref wrapping across
 * lines is a better outcome than an ellipsis in the middle of the name whose
 * history is about to be integrated.
 */
function RefChip({ value, emphasis }: { value: string; emphasis?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline px-1.5 py-0.5 rounded bg-tint/[0.07] border border-tint/[0.08] text-2xs font-mono break-words",
        emphasis ? "text-text-primary" : "text-text-secondary"
      )}
    >
      {value}
    </span>
  );
}

/** Git did not answer at all. The failure is stated once, below, not per row. */
function Unknown() {
  return <span className="text-text-secondary text-2xs">&mdash;</span>;
}

/**
 * Skeleton bone. `animate-pulse-delayed` carries the 400ms Doherty gate in its
 * own `animation-delay`, so a read that returns quickly paints nothing at all.
 */
function Bone({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block h-3.5 rounded bg-tint/[0.08] animate-pulse-delayed", className)}
    />
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
