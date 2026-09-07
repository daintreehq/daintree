import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { actionService } from "@/services/ActionService";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

interface UpstreamSyncBadgeProps {
  aheadCount: number | undefined;
  behindCount: number | undefined;
  isFetchInFlight: boolean;
  lastFetchedAt: number | null | undefined;
  fetchAuthFailed: boolean;
  fetchNetworkFailed: boolean;
  hasAuthFailedSignIn: boolean;
  /** Provider whose settings the sign-in affordance routes to; null hides nothing but routes to the tab root. */
  authProviderId?: string | null;
  containerGapClass: string;
  baseBranchName?: string | null;
  baseAheadCount?: number | null;
  baseBehindCount?: number | null;
  baseMatchesUpstream?: boolean;
  /**
   * Ref the base counts were measured against (`upstream/main`). Named in the
   * tooltip while the compact pill keeps the bare branch name — the pill is
   * scanned across a dozen cards, the tooltip is where the disambiguation
   * belongs.
   */
  baseCompareRef?: string | null;
  /**
   * True when the branch has no upstream configured. Since `87dc51fa9` stopped
   * pointing fresh topic branches at their base, this is the normal state of
   * every worktree between creation and its first push, so the line has to be
   * able to say it rather than just showing nothing.
   *
   * It is "no upstream", not "never pushed": `git push origin topic` without
   * `-u` leaves a remote branch behind with no tracking config, and so does
   * `git branch --unset-upstream`. The tooltip says the configured thing;
   * only the compact marker abbreviates.
   */
  hasNoUpstream?: boolean;
  fetchIntervalMs?: number;
}

const STALENESS_MULTIPLIER = 1.5;
const FLASH_DURATION_MS = 250;

export function UpstreamSyncBadge({
  aheadCount,
  behindCount,
  isFetchInFlight,
  lastFetchedAt,
  fetchAuthFailed,
  fetchNetworkFailed,
  hasAuthFailedSignIn,
  authProviderId,
  containerGapClass,
  baseBranchName,
  baseAheadCount,
  baseBehindCount,
  baseMatchesUpstream,
  baseCompareRef,
  hasNoUpstream,
  fetchIntervalMs,
}: UpstreamSyncBadgeProps) {
  const hasAhead = aheadCount !== undefined && aheadCount > 0;
  const hasBehind = behindCount !== undefined && behindCount > 0;
  const hasBaseAhead = baseAheadCount != null && baseAheadCount > 0;
  const hasBaseBehind = baseBehindCount != null && baseBehindCount > 0;

  // The base segment is a *relationship*, not an alarm: it renders whenever we
  // know which branch this one is measured against, and only its glyph and
  // counts change with the state. Gating the whole line on a non-zero count —
  // what it used to do — meant a worktree sitting exactly on its base with no
  // upstream yet said nothing at all about where it came from, which is the
  // state every worktree is in the moment it is created.
  const hasBaseName = baseBranchName != null;
  // `BaseDivergence` tries the remote compare ref first and falls back to the
  // LOCAL base branch when that ref won't resolve — which is exactly what
  // "Fetch and prune" leaves behind when the base branch is gone from the
  // remote (#12091). The fallback is observable here because the fallback ref
  // is the bare branch name where a healthy compare is `remote/branch`, so the
  // tooltip can say the counts are local rather than passing them off as
  // measured against the remote.
  //
  // What it must NOT say is WHY. The same fallback covers a pruned-away ref, a
  // repo with no remote at all, and a transient git error, and the renderer
  // cannot tell them apart — so the copy reports the comparison it got, not a
  // cause it did not observe.
  const comparedWithLocalBase =
    hasBaseName && baseCompareRef != null && baseCompareRef === baseBranchName;
  // `||`, not `??`: an empty-string compare ref has to fall through to the
  // branch name the same way it always did, or the tooltip renders "behind ".
  const compareLabel = comparedWithLocalBase
    ? `local ${baseBranchName}`
    : baseCompareRef || baseBranchName;
  const showBaseDivergence = hasBaseName && (hasBaseAhead || hasBaseBehind);
  // Equality has to be measured, not assumed. `BaseDivergence` keeps the base
  // name and nulls a count it could not parse, so a missing count is "we do
  // not know", and the resting form is the one claim we cannot make on a
  // guess — it says the two are the same commit.
  const baseCountsKnown = baseAheadCount != null && baseBehindCount != null;

  // A branch can end up tracking its own base — `git worktree add -b topic
  // --track origin/develop` writes `branch.topic.merge = refs/heads/develop`,
  // and any branch may be pointed at an integration branch by hand. Then
  // `@{u}` and the base compare ref are the same commit, both pairs carry the
  // same number, and only one of them says what the number is counted against.
  //
  // Drop the unlabelled pair, never the label. The old rule did the reverse,
  // so two worktrees on the same commit off the same base rendered as
  // `Δ develop ↓4` and a bare `↓4` purely on how their tracking config
  // happened to be written — and a bare `↓4` beside a labelled one reads as a
  // different measurement, not the same one.
  //
  // Gated on the base pair actually being non-zero so an inter-pass race that
  // zeroes the base counts while upstream still reports drift falls back to
  // the upstream form rather than rendering nothing.
  const dedupeToBase = baseMatchesUpstream === true && showBaseDivergence;
  const showUpstreamDelta = (hasAhead || hasBehind) && !dedupeToBase;

  // That same race is the one state where the resting form must not appear.
  // `baseMatchesUpstream` says @{u} and the base compare ref are the same
  // commit, so the two pairs are one measurement — and `↓4 ≡ develop` would
  // have the halves contradicting each other about it. The upstream pair is
  // the fresher of the two there (git status runs every pass; the base counts
  // can be served from their stat-keyed cache), so it keeps the line and the
  // equality claim stands down. Where the two refs genuinely differ,
  // `↑3 ≡ develop` is not a contradiction and renders as it reads: three
  // commits the remote branch has not got, none that develop has not got.
  const showBaseResting =
    hasBaseName &&
    baseCountsKnown &&
    !showBaseDivergence &&
    !(baseMatchesUpstream === true && showUpstreamDelta);
  const showBaseSegment = showBaseDivergence || showBaseResting;

  // Flash only on changes the user can actually see — track display-gated
  // values so a null→0 transition on hidden base counts doesn't flash, and
  // a baseMatchesUpstream flip that moves the counts between the two forms
  // does.
  const displayedAhead = showUpstreamDelta && hasAhead ? aheadCount : null;
  const displayedBehind = showUpstreamDelta && hasBehind ? behindCount : null;
  const displayedBaseAhead = showBaseDivergence && hasBaseAhead ? baseAheadCount : null;
  const displayedBaseBehind = showBaseDivergence && hasBaseBehind ? baseBehindCount : null;

  const prevDisplayedRef = useRef({
    displayedAhead,
    displayedBehind,
    displayedBaseAhead,
    displayedBaseBehind,
  });
  const [isFlashing, setIsFlashing] = useState(false);

  useEffect(() => {
    const prev = prevDisplayedRef.current;
    const changed =
      prev.displayedAhead !== displayedAhead ||
      prev.displayedBehind !== displayedBehind ||
      prev.displayedBaseAhead !== displayedBaseAhead ||
      prev.displayedBaseBehind !== displayedBaseBehind;
    prevDisplayedRef.current = {
      displayedAhead,
      displayedBehind,
      displayedBaseAhead,
      displayedBaseBehind,
    };
    if (!changed) return;
    setIsFlashing(true);
    const safetyTimer = window.setTimeout(() => setIsFlashing(false), FLASH_DURATION_MS);
    return () => window.clearTimeout(safetyTimer);
  }, [displayedAhead, displayedBehind, displayedBaseAhead, displayedBaseBehind]);

  const isStale = useMemo(() => {
    if (lastFetchedAt == null || fetchIntervalMs == null) return false;
    return Date.now() - lastFetchedAt > fetchIntervalMs * STALENESS_MULTIPLIER;
  }, [lastFetchedAt, fetchIntervalMs]);

  const handleSignInClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      // Auth failures suspend background fetches indefinitely (#9736). Clearing the
      // suspension and re-fetching only happens on an explicit user action, so kick
      // it off here — fire-and-forget, the settings tab below is the recovery path
      // if the token still needs fixing.
      safeFireAndForget(window.electron.worktree.retryAuthFetch(), {
        context: "Retry auth-suspended fetch from sync badge",
      });
      void actionService.dispatch(
        "app.settings.openTab",
        authProviderId ? { tab: "code-forge", subtab: authProviderId } : { tab: "code-forge" },
        { source: "user" }
      );
    },
    [authProviderId]
  );

  if (fetchAuthFailed && hasAuthFailedSignIn) {
    return (
      // autoDismiss={false}: the pill can ellipsize the base name now, so this
      // tooltip is the only place to read it in full — a full-text reveal, which
      // `tooltip.tsx` exempts from the 2.5s deadline meant for transient hints.
      <Tooltip autoDismiss={false}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleSignInClick}
            data-no-dnd
            className={cn(
              "flex items-center text-3xs font-mono tabular-nums cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
              containerGapClass
            )}
            data-testid="upstream-sync-indicator"
            data-fetch-auth-failed="true"
            aria-label="Forge authentication failed — click to reconnect"
          >
            {/* min-w-0: this row is a flex *item* of the button above it, so
                its own automatic minimum size is its min-content width — the
                whole unbroken branch name, since the label below sets
                white-space: nowrap. Without this the row refuses to shrink and
                the label never gets narrow enough to ellipsize. The normal
                variant has no equivalent level: its row is a cross-axis child
                of the card's column, where min-width: auto resolves to 0. */}
            <span className="flex items-center gap-1.5 text-text-muted min-w-0">
              {showUpstreamDelta && hasAhead && <span className="shrink-0">↑{aheadCount}</span>}
              {showUpstreamDelta && hasBehind && <span className="shrink-0">↓{behindCount}</span>}
              {showBaseSegment && (
                <>
                  <span className="min-w-0 truncate" data-testid="upstream-sync-base">
                    {showBaseDivergence ? "Δ" : "≡"} {baseBranchName}
                  </span>
                  {displayedBaseAhead != null && (
                    <span className="shrink-0">↑{displayedBaseAhead}</span>
                  )}
                  {displayedBaseBehind != null && (
                    <span className="shrink-0">↓{displayedBaseBehind}</span>
                  )}
                  {hasNoUpstream && (
                    <span className="shrink-0" data-testid="upstream-sync-unpushed">
                      · local
                    </span>
                  )}
                </>
              )}
              {!showUpstreamDelta && !showBaseSegment && <span>—</span>}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          <div>Forge authentication failed</div>
          <div className="text-text-secondary mt-0.5">Click to reconnect your code forge</div>
          {/* The pill can now ellipsize the base name, and this variant's copy
              never said what it was. Without this line the auth state is the
              one place a truncated name has nowhere to be read in full. */}
          {showBaseSegment && baseBranchName && (
            <div className="text-text-muted break-words">Compared with {compareLabel}</div>
          )}
          {lastFetchedAt != null && (
            <div className="text-text-muted">Last fetched {formatRelativeTime(lastFetchedAt)}</div>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  if (!showUpstreamDelta && !showBaseSegment) return null;

  return (
    // Same full-text reveal as the auth-failed variant above.
    <Tooltip autoDismiss={false}>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "flex items-center text-3xs font-mono tabular-nums",
            containerGapClass,
            isFlashing && "animate-upstream-badge-flash",
            fetchNetworkFailed && "opacity-75",
            isStale && !isFetchInFlight && "opacity-50 transition-opacity duration-150"
          )}
          data-testid="upstream-sync-indicator"
          data-fetch-in-flight={isFetchInFlight ? "true" : undefined}
          data-fetch-network-failed={fetchNetworkFailed ? "true" : undefined}
          data-stale={isStale ? "true" : undefined}
          onAnimationEnd={() => setIsFlashing(false)}
        >
          {showUpstreamDelta && hasAhead && (
            <span className="text-status-success shrink-0">↑{aheadCount}</span>
          )}
          {showUpstreamDelta && hasBehind && (
            <span className="text-status-warning shrink-0">↓{behindCount}</span>
          )}
          {showBaseSegment && (
            <>
              {/* `text-secondary`, not `text-muted/60`: this names the branch
                  the counts beside it are counted against, so it is the only
                  thing that makes them mean anything. `text-muted` has no
                  contrast floor on the darkest palettes and the /60 halved
                  what was left — 1.45:1 on namib, 2.06:1 on bondi, so the
                  branch name dropped out of a line whose green +N stayed
                  legible beside it. The line is already 11px and sits under
                  two brighter rows; that is where its de-emphasis comes
                  from.

                  Δ means drift, so it cannot carry the resting state: a bare
                  `Δ develop` beside a `Δ develop ↑3` would claim a divergence
                  it does not have. ≡ says the two are the same commit, which
                  is the whole content of the resting line. */}
              {/* The only thing on this line allowed to shrink. Everything
                  beside it is shrink-0, so a base branch long enough to
                  outgrow the card ellipsizes here instead of pushing the
                  counts and the · local marker off the right edge — they are
                  the state the line exists to carry, and the tooltip below
                  still names the branch in full. Glyph and name stay one text
                  run so the ellipsis eats the name from the right. */}
              <span
                className="text-text-secondary min-w-0 truncate"
                data-testid="upstream-sync-base"
              >
                {showBaseDivergence ? "Δ" : "≡"} {baseBranchName}
              </span>
              {hasBaseAhead && (
                <span className="text-status-success shrink-0">↑{baseAheadCount}</span>
              )}
              {hasBaseBehind && (
                <span className="text-status-warning shrink-0">↓{baseBehindCount}</span>
              )}
              {/* Same tier as the branch name it qualifies, so it inherits the
                  same contrast reasoning — never text-muted. */}
              {hasNoUpstream && (
                <span className="text-text-secondary shrink-0" data-testid="upstream-sync-unpushed">
                  · local
                </span>
              )}
            </>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
        {showUpstreamDelta && (
          <div>
            {hasAhead && (
              <span>
                {aheadCount} commit{aheadCount !== 1 ? "s" : ""} ahead
              </span>
            )}
            {hasAhead && hasBehind && <span>, </span>}
            {hasBehind && (
              <span>
                {behindCount} commit{behindCount !== 1 ? "s" : ""} behind
              </span>
            )}
            <span> upstream</span>
          </div>
        )}
        {showBaseDivergence && baseBranchName && (
          <div className="text-text-muted/70 break-words">
            {hasBaseAhead && (
              <span>
                {baseAheadCount} ahead of {compareLabel}
              </span>
            )}
            {hasBaseAhead && hasBaseBehind && <span>, </span>}
            {hasBaseBehind && (
              <span>
                {baseBehindCount} behind {compareLabel}
              </span>
            )}
          </div>
        )}
        {showBaseResting && baseBranchName && (
          <div className="text-text-muted break-words">In sync with {compareLabel}</div>
        )}
        {comparedWithLocalBase && showBaseSegment && (
          <div className="text-text-muted" data-testid="upstream-sync-local-base">
            Remote comparison unavailable
          </div>
        )}
        {hasNoUpstream && showBaseSegment && (
          <div className="text-text-muted">No upstream branch configured</div>
        )}
        {fetchNetworkFailed && (
          <div className="text-status-warning/80" data-testid="upstream-sync-network-warning">
            Couldn't reach the remote
          </div>
        )}
        {isStale && lastFetchedAt != null && (
          <div className="text-text-muted/70">
            Stale (last fetched {formatRelativeTime(lastFetchedAt)})
          </div>
        )}
        {!isStale && lastFetchedAt != null && (
          <div className="text-text-muted">Last fetched {formatRelativeTime(lastFetchedAt)}</div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
