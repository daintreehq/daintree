import { useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { actionService } from "@/services/ActionService";
import { useSkeletonGate } from "@/hooks/useDeferredLoading";
import { formatRelativeTime } from "@/lib/formatRelativeTime";

interface UpstreamSyncBadgeProps {
  aheadCount: number | undefined;
  behindCount: number | undefined;
  isFetchInFlight: boolean;
  lastFetchedAt: number | null | undefined;
  fetchAuthFailed: boolean;
  fetchNetworkFailed: boolean;
  isGitHubProvider: boolean;
  containerGapClass: string;
  baseBranchName?: string | null;
  baseAheadCount?: number | null;
  baseBehindCount?: number | null;
  baseMatchesUpstream?: boolean;
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
  isGitHubProvider,
  containerGapClass,
  baseBranchName,
  baseAheadCount,
  baseBehindCount,
  baseMatchesUpstream,
  fetchIntervalMs,
}: UpstreamSyncBadgeProps) {
  const hasAhead = aheadCount !== undefined && aheadCount > 0;
  const hasBehind = behindCount !== undefined && behindCount > 0;
  const showPulse = useSkeletonGate(isFetchInFlight);

  const isStale = useMemo(() => {
    if (lastFetchedAt == null || fetchIntervalMs == null) return false;
    return Date.now() - lastFetchedAt > fetchIntervalMs * STALENESS_MULTIPLIER;
  }, [lastFetchedAt, fetchIntervalMs]);

  const showBaseDivergence =
    baseBranchName != null &&
    !baseMatchesUpstream &&
    ((baseAheadCount != null && baseAheadCount > 0) ||
      (baseBehindCount != null && baseBehindCount > 0));

  const handleSignInClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "code-forge", subtab: "github", sectionId: "github-token" },
      { source: "user" }
    );
  }, []);

  if (fetchAuthFailed && isGitHubProvider) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleSignInClick}
            data-no-dnd
            className={cn(
              "flex items-center text-[10px] font-mono tabular-nums cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent",
              containerGapClass
            )}
            data-testid="upstream-sync-indicator"
            data-fetch-auth-failed="true"
            aria-label="GitHub authentication failed — click to reconnect"
          >
            <span className="flex items-center gap-1.5 grayscale opacity-50 text-text-primary/50">
              {hasAhead && <span>↑{aheadCount}</span>}
              {hasBehind && <span>↓{behindCount}</span>}
              {!hasAhead && !hasBehind && <span>—</span>}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          <div>GitHub authentication failed</div>
          <div className="text-daintree-text/70 mt-0.5">Click to reconnect GitHub</div>
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
            "flex items-center text-[10px] font-mono tabular-nums",
            containerGapClass,
            isFetchInFlight && showPulse && "animate-pulse-immediate",
            fetchNetworkFailed && "opacity-75",
            isStale && !isFetchInFlight && "opacity-50 transition-opacity duration-150"
          )}
          data-testid="upstream-sync-indicator"
          data-fetch-in-flight={isFetchInFlight ? "true" : undefined}
          data-fetch-network-failed={fetchNetworkFailed ? "true" : undefined}
          data-stale={isStale ? "true" : undefined}
        >
          {hasAhead && <span className="text-status-success">↑{aheadCount}</span>}
          {hasBehind && <span className="text-status-warning">↓{behindCount}</span>}
          {showBaseDivergence && (
            <span className="text-text-muted/60">
              &Delta; {baseBranchName}{" "}
              {baseAheadCount != null && baseAheadCount > 0 && <>↑{baseAheadCount}</>}
              {baseBehindCount != null && baseBehindCount > 0 && <>↓{baseBehindCount}</>}
            </span>
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
                {baseAheadCount} ahead of {baseBranchName}
              </span>
            )}
            {baseBehindCount != null && baseBehindCount > 0 && (
              <span>
                {baseBehindCount} behind {baseBranchName}
              </span>
            )}
          </div>
        )}
        {fetchNetworkFailed && (
          <div className="text-status-warning/80" data-testid="upstream-sync-network-warning">
            Couldn't reach origin
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
