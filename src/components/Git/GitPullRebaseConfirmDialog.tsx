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
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import {
  buildGitRemoteOperationPreview,
  formatGitPushDestination,
  type GitPreviewCommit,
  type GitRebaseRangeFacts,
} from "@/components/Git/gitRemoteOperationPreview";
import type { GitPushDestination } from "@shared/types/git";

const SHORT_HASH_LEN = 7;

/** Rows the skeleton draws. Enough to hold the panel's height without claiming a count. */
const SKELETON_ROWS = 3;

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

  const [branch, setBranch] = useState<string | null>(null);
  const [upstream, setUpstream] = useState<GitPushDestination | null>(null);
  const [commits, setCommits] = useState<GitPreviewCommit[] | null>(null);
  const [rebaseRange, setRebaseRange] = useState<GitRebaseRangeFacts | null>(null);
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
    setBranch(null);
    setUpstream(null);
    setCommits(null);
    setRebaseRange(null);
    setLoadedFor(null);

    safeFireAndForget(
      // Shared with the MCP confirm surface so agent and human approvers see the
      // identical fresh upstream and replay set (#11538).
      buildGitRemoteOperationPreview(cwd, "pull-rebase")
        .then((preview) => {
          if (requestIdRef.current !== requestId) return;
          setBranch(preview.branch);
          // The UPSTREAM, not the push destination: this dialog confirms a rebase
          // onto what the branch integrates from, and in a triangular workflow those
          // are different repositories (#11746).
          setUpstream(preview.pullSource);
          setCommits(preview.commits);
          setRebaseRange(preview.rebaseRange);
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
      setBranch(null);
      setUpstream(null);
      setCommits(null);
      setRebaseRange(null);
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

  const upstreamLabel = upstream ? formatGitPushDestination(upstream) : null;
  // Settled means "this request's own fresh answer is on screen". `isLoading` starts
  // false and the read only begins in an effect, so a check that asked merely whether
  // loading had finished would classify the first painted frame as "no upstream" and
  // flash that error before anything had been read.
  const isSettled = !isLoading && !loadError && loadedFor === cwd;
  // Checked BEFORE the missing-upstream branch. A detached HEAD also resolves no
  // upstream, but telling someone with no branch checked out to set an upstream for
  // it is both the wrong diagnosis and an unfollowable fix.
  const isDetached = isSettled && commits !== null && branch === null;
  const isUpstreamMissing = isSettled && !isDetached && upstream === null;
  const isLoaded = isSettled && commits !== null;
  const isUnfetched = rebaseRange?.rangeBasis === "unfetched";
  const isMeasuredEmpty = isLoaded && commits.length === 0 && upstream !== null && !isUnfetched;
  // A measured-empty range means the rebase would replay nothing, and the `behind`
  // count is the only thing that separates a branch already level with its upstream
  // from one the rebase would move. It does NOT separate "purely behind" from
  // anything else: the replay set is measured with `--no-merges --cherry-pick
  // --right-only`, so a branch carrying merge commits, or commits the upstream
  // already holds as equivalent patches, measures empty here too — and those are
  // local-only commits the rebase drops rather than fast-forwards past. Neither
  // line below may claim a fast-forward on the strength of `behind` alone.
  const isInSync = isMeasuredEmpty && (rebaseRange?.behind ?? 0) === 0;
  const isBehindWithNothingToReplay = isMeasuredEmpty && (rebaseRange?.behind ?? 0) > 0;
  const isEmptyUnfetched = isLoaded && upstream !== null && isUnfetched;
  const total = rebaseRange?.total ?? commits?.length ?? 0;
  const hiddenCount = commits ? Math.max(0, total - commits.length) : 0;

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
  const confirmDisabled = !isSettled || commits === null || !upstream || !!loadError || isUnfetched;

  // Names the one unmet prerequisite rather than leaving a dead button to be read as
  // arbitrary. Ordered by which the user can act on first.
  const blockedReason = loadError
    ? "Retry the preview to continue"
    : isDetached
      ? "Check out a branch to continue"
      : isUpstreamMissing
        ? "Set an upstream to continue"
        : isUnfetched
          ? "Fetch the upstream to continue"
          : showPendingHint
            ? "Checking what would be replayed…"
            : null;

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => resolveConfirmation(false)}
      title="Pull and rebase local commits?"
      // Describes what rebasing does rather than asserting what this one will do, so
      // the same sentence stays true in the states with nothing to point at — no
      // upstream, nothing to replay, preview failed. It also names the concrete
      // consequence: "cannot be undone" told the user nothing they could act on,
      // where "the hashes change" is the fact that actually breaks their branch.
      description={
        <span>
          Rebasing replays your local commits on top of the upstream, so each becomes a new commit
          with a different hash and anything pointing at the old ones stops matching.
        </span>
      }
      confirmLabel="Pull and rebase"
      cancelLabel="Cancel"
      variant="destructive"
      hasPreview={true}
      // Deliberately NOT `isConfirmLoading={isLoading}`. That prop means "the
      // confirmed action is running": it overlays a spinner on the primary, dims its
      // label to 30%, and disables Cancel. Wiring the PREVIEW read to it drew a
      // spinner across the word "rebase" while the full label was still rendered
      // underneath, and — because AppDialog's initial-focus pass finds the Cancel
      // button by selector and calls `.focus()` on it without checking it is enabled
      // — left focus outside the dialog entirely for the whole read.
      confirmDisabled={confirmDisabled}
      hint={blockedReason}
      onConfirm={() => resolveConfirmation(true)}
    >
      <div className="rounded border border-tint/[0.08] bg-tint/[0.04] text-xs">
        {/* Rewrites first, then Onto: the pair reads in the order the operation
            happens — this branch is taken and replayed onto that ref — so the
            reader does not have to hold the base in mind while working out what
            it applies to. Same local-then-remote order as the sibling's From/To,
            with the vocabulary that keeps a rewrite from reading as a transfer. */}
        <dl className="px-3 py-2 space-y-1.5" data-testid="git-pull-rebase-upstream-summary">
          {/* "Rewrites" only where a rewrite is actually on the table. With an
              empty replay set the panel below says nothing would be replayed,
              and a label asserting a rewrite two rows above is the same
              contradiction the caution note had. */}
          <SummaryRow label={isLoaded && commits.length > 0 ? "Rewrites" : "Branch"}>
            {branch && isSettled ? (
              <RefChip value={branch} emphasis />
            ) : !isSettled && !loadError ? (
              <Bone className="w-40" />
            ) : loadError ? (
              <Unknown />
            ) : (
              <Unresolved />
            )}
          </SummaryRow>
          <SummaryRow label="Onto">
            {upstreamLabel && isSettled ? (
              <RefChip value={upstreamLabel} emphasis />
            ) : !isSettled && !loadError ? (
              <Bone className="w-48" />
            ) : loadError ? (
              <Unknown />
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
            Commits to replay
            {isSettled && total > 0 && (
              <span className="ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal">
                {total}
              </span>
            )}
          </span>
        </div>

        {!isSettled && !loadError && (
          // `Skeleton` is what makes this reach a screen reader: the bones alone are
          // decorative, so a blocked primary with no announced busy state left an AT
          // user with a dead button and no explanation.
          <Skeleton
            label="Checking which commits this would replay"
            data-testid="git-pull-rebase-commits-loading"
          >
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
              <div className="font-medium">Couldn&apos;t read which commits this would replay</div>
              <div className="mt-0.5 text-daintree-text/70 break-words">{loadError}</div>
              <Button
                variant="ghost-danger"
                size="sm"
                onClick={loadPreview}
                data-testid="git-pull-rebase-commits-retry"
                className="mt-1.5 h-6 px-2 text-[11px]"
              >
                <RefreshCw className="w-3 h-3" />
                Retry
              </Button>
            </div>
          </div>
        )}

        {isDetached && (
          <div className="px-3 py-3 text-status-error flex items-start gap-2" role="alert">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0" data-testid="git-pull-rebase-detached-head">
              <div className="font-medium">No branch checked out</div>
              <div className="mt-0.5 text-daintree-text/70">
                This worktree is on a detached HEAD, so there is no branch history to replay. Check
                one out and try again.
              </div>
            </div>
          </div>
        )}

        {isUpstreamMissing && (
          <div className="px-3 py-3 text-status-error flex items-start gap-2" role="alert">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0" data-testid="git-pull-rebase-no-destination">
              <div className="font-medium">No upstream to rebase onto</div>
              <div className="mt-0.5 text-daintree-text/70">
                This branch doesn&apos;t track anything, so there is nothing to replay it onto.
                Point it at a remote branch:
                {/* Carries its argument, unlike the bare `git branch --set-upstream-to`
                    the old copy printed: that form takes a required value, so following
                    the instruction as written just returned an error and left the user
                    back on this screen. The trailing branch name is omitted because it
                    defaults to HEAD, which is the branch this state is about — and
                    naming it twice was long enough to run off the frame.

                    Wraps rather than scrolls: a ref that decides which repository gets
                    replayed onto must never be half-shown, and a clipped command reads
                    as a rendering fault rather than as something scrollable. */}
                {/* Both halves left as placeholders. The remote branch is the one
                    fact this state definitionally does not have, and substituting
                    the local name for it is a silent fallback default on a
                    destructive surface (#7880) that is simply wrong for every
                    branch whose upstream is named differently. */}
                <span className="mt-1 block font-mono text-daintree-text/80 break-all">
                  git branch --set-upstream-to=&lt;remote&gt;/&lt;branch&gt;
                </span>
              </div>
            </div>
          </div>
        )}

        {isInSync && (
          <div className="px-3 py-3 text-daintree-text/60" data-testid="git-pull-rebase-in-sync">
            Nothing to replay &mdash; {branch} already matches {upstreamLabel}.
          </div>
        )}

        {isBehindWithNothingToReplay && (
          <div
            className="px-3 py-3 text-daintree-text/60"
            data-testid="git-pull-rebase-behind-nothing-to-replay"
          >
            Nothing to replay &mdash; {branch} is {rebaseRange?.behind} behind {upstreamLabel} and
            has no commit the rebase would replay on top of it.
          </div>
        )}

        {isEmptyUnfetched && (
          // Blocking, not a quiet note: this is the one state where the surface
          // cannot answer the question it exists to answer, so it gets the same
          // alert treatment as the other states that refuse the operation.
          <div className="px-3 py-3 text-status-error flex items-start gap-2" role="alert">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0" data-testid="git-pull-rebase-empty-unfetched">
              <div className="font-medium">Nothing to compare against yet</div>
              <div className="mt-0.5 text-daintree-text/70">
                {upstreamLabel} isn&apos;t available locally, so which of your commits would be
                rewritten can&apos;t be worked out. Fetch it and try again:
                <span className="mt-1 block font-mono text-daintree-text/80 break-all">
                  git fetch {upstream?.remote}
                </span>
              </div>
            </div>
          </div>
        )}

        {isLoaded && commits.length > 0 && (
          // A scrollable region with no focusable children of its own has to be
          // reachable by keyboard in its own right (WCAG 2.1.1), and the fades are
          // what say "there is more" — a row clipped by the panel edge was the only
          // previous cue, and it read as a rendering fault rather than as overflow.
          <ScrollShadow
            className="max-h-[180px]"
            scrollClassName="scroll-py-8"
            tabIndex={0}
            role="region"
            aria-label={`Commits to replay${upstreamLabel ? ` onto ${upstreamLabel}` : ""}`}
          >
            <ul className="px-3 py-2 space-y-1.5">
              {commits.map((commit) => (
                <li
                  key={commit.hash}
                  className="flex items-baseline gap-2"
                  data-testid="git-pull-rebase-commit-row"
                >
                  <span className="font-mono text-[11px] text-daintree-text/55 shrink-0 tabular-nums">
                    {commit.hash.slice(0, SHORT_HASH_LEN)}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-daintree-text/90">
                    {commit.message}
                  </span>
                  {/* Bounded, unlike the rest of the row: an author is the least
                      important column here, and left unbounded a long name took 45%
                      of the width and truncated the subject to twenty characters. */}
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
      {/* The quietest tier on the surface, and last: the least specific thing the
          dialog has to say, but the one question a rebase raises that nothing else
          here answers.

          Gated on there actually being a replay. It used to render in every state,
          so a branch with nothing to replay, a branch with no upstream and a failed
          read all carried a caution about conflicts during a replay the panel
          directly above had just said would not happen — and it made the empty
          state taller than the one-commit state. */}
      {isLoaded && commits.length > 0 && (
        <p className="text-[11px] text-daintree-text/55">
          If a replay hits a conflict, Git stops mid-rebase and leaves the branch there to resolve.
        </p>
      )}
    </ConfirmDialog>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-[10px] uppercase tracking-wider text-daintree-text/55 shrink-0 w-14">
        {label}
      </dt>
      <dd className="flex-1 min-w-0">{children}</dd>
    </div>
  );
}

/**
 * A ref as a value rather than a word in a sentence.
 *
 * `break-words` rather than truncation: the upstream is the one fact on this surface
 * that must never be shortened, and a 90-character fork ref wrapping across three
 * lines is a better outcome than an ellipsis in the middle of the repository name
 * whose history is about to be replayed onto.
 */
function RefChip({ value, emphasis }: { value: string; emphasis?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline px-1.5 py-0.5 rounded bg-tint/[0.07] border border-tint/[0.08] text-[11px] font-mono break-words",
        emphasis ? "text-daintree-text" : "text-daintree-text/70"
      )}
    >
      {value}
    </span>
  );
}

/** Git answered, and the answer was "no upstream anyone can name". */
function Unresolved() {
  return <span className="text-status-error text-[11px]">Not resolved</span>;
}

/** Git did not answer at all. The failure is stated once, below, not per row. */
function Unknown() {
  return <span className="text-daintree-text/55 text-[11px]">&mdash;</span>;
}

/**
 * Skeleton bone. `animate-pulse-delayed` carries the 400ms Doherty gate in its own
 * `animation-delay`, so a read that returns quickly paints nothing at all.
 */
function Bone({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block h-3.5 rounded bg-tint/[0.08] animate-pulse-delayed", className)}
    />
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
