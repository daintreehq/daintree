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
  fetchIntervalMs?: number;
}

const STALENESS_MULTIPLIER = 1.5;

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
  fetchIntervalMs,
}: UpstreamSyncBadgeProps) {
  const hasAhead = aheadCount !== undefined && aheadCount > 0;
  const hasBehind = behindCount !== undefined && behindCount > 0;

  const showBaseDivergence =
    baseBranchName != null &&
    !baseMatchesUpstream &&
    ((baseAheadCount != null && baseAheadCount > 0) ||
      (baseBehindCount != null && baseBehindCount > 0));

  // Flash only on changes the user can actually see — track display-gated
  // values so a null→0 transition on hidden base counts doesn't flash, and
  // a baseMatchesUpstream flip that reveals existing counts does.
  const displayedAhead = hasAhead ? aheadCount : null;
  const displayedBehind = hasBehind ? behindCount : null;
  const displayedBaseAhead =
    showBaseDivergence && baseAheadCount != null && baseAheadCount > 0 ? baseAheadCount : null;
  const displayedBaseBehind =
    showBaseDivergence && baseBehindCount != null && baseBehindCount > 0 ? baseBehindCount : null;

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
    const safetyTimer = window.setTimeout(() => setIsFlashing(false), 250);
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
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleSignInClick}
            data-no-dnd
            className={cn(
              "flex items-center text-3xs font-mono tabular-nums cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent",
              containerGapClass
            )}
            data-testid="upstream-sync-indicator"
            data-fetch-auth-failed="true"
            aria-label="Forge authentication failed — click to reconnect"
          >
            <span className="flex items-center gap-1.5 text-text-muted">
              {hasAhead && <span>↑{aheadCount}</span>}
              {hasBehind && <span>↓{behindCount}</span>}
              {!hasAhead && !hasBehind && <span>—</span>}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          <div>Forge authentication failed</div>
          <div className="text-daintree-text/70 mt-0.5">Click to reconnect your code forge</div>
          {lastFetchedAt != null && (
            <div className="text-text-muted">Last fetched {formatRelativeTime(lastFetchedAt)}</div>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  if (!hasAhead && !hasBehind && !showBaseDivergence) return null;

  return (
    <Tooltip>
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
          {hasAhead && <span className="text-status-success">↑{aheadCount}</span>}
          {hasBehind && <span className="text-status-warning">↓{behindCount}</span>}
          {showBaseDivergence && (
            <>
              {/* `text-secondary`, not `text-muted/60`: this names the branch
                  the counts beside it are counted against, so it is the only
                  thing that makes them mean anything. `text-muted` has no
                  contrast floor on the darkest palettes and the /60 halved
                  what was left — 1.45:1 on namib, 2.06:1 on bondi, so the
                  branch name dropped out of a line whose green +N stayed
                  legible beside it. The line is already 11px and sits under
                  two brighter rows; that is where its de-emphasis comes
                  from. */}
              <span className="text-text-secondary">&Delta; {baseBranchName}</span>
              {baseAheadCount != null && baseAheadCount > 0 && (
                <span className="text-status-success">↑{baseAheadCount}</span>
              )}
              {baseBehindCount != null && baseBehindCount > 0 && (
                <span className="text-status-warning">↓{baseBehindCount}</span>
              )}
            </>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
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
        {showBaseDivergence && baseBranchName && (
          <div className="text-text-muted/70">
            {baseAheadCount != null && baseAheadCount > 0 && (
              <span>
                {baseAheadCount} ahead of {baseCompareRef || baseBranchName}
              </span>
            )}
            {baseBehindCount != null && baseBehindCount > 0 && (
              <span>
                {baseBehindCount} behind {baseCompareRef || baseBranchName}
              </span>
            )}
          </div>
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
