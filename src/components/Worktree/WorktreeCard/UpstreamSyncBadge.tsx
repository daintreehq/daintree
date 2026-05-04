import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { actionService } from "@/services/ActionService";

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function formatLastFetched(epochMs: number, now: number = Date.now()): string {
  const deltaSeconds = Math.round((epochMs - now) / 1000);
  const absSeconds = Math.abs(deltaSeconds);
  if (absSeconds < 60) return RELATIVE_TIME_FORMATTER.format(deltaSeconds, "second");
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (Math.abs(deltaMinutes) < 60) return RELATIVE_TIME_FORMATTER.format(deltaMinutes, "minute");
  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) return RELATIVE_TIME_FORMATTER.format(deltaHours, "hour");
  const deltaDays = Math.round(deltaHours / 24);
  return RELATIVE_TIME_FORMATTER.format(deltaDays, "day");
}

interface UpstreamSyncBadgeProps {
  aheadCount: number | undefined;
  behindCount: number | undefined;
  isFetchInFlight: boolean;
  lastFetchedAt: number | null | undefined;
  fetchAuthFailed: boolean;
  fetchNetworkFailed: boolean;
  isGitHubRemote: boolean;
  containerGapClass: string;
}

export function UpstreamSyncBadge({
  aheadCount,
  behindCount,
  isFetchInFlight,
  lastFetchedAt,
  fetchAuthFailed,
  fetchNetworkFailed,
  isGitHubRemote,
  containerGapClass,
}: UpstreamSyncBadgeProps) {
  const hasAhead = aheadCount !== undefined && aheadCount > 0;
  const hasBehind = behindCount !== undefined && behindCount > 0;

  const handleSignInClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "github", sectionId: "github-token" },
      { source: "user" }
    );
  }, []);

  if (fetchAuthFailed && isGitHubRemote) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleSignInClick}
            className="flex items-center text-[10px] text-status-warning/80 hover:text-status-warning transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent rounded-sm cursor-pointer"
            data-testid="upstream-sync-auth-cta"
          >
            Sign in to refresh
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          <div>Couldn't reach origin — GitHub credentials failed</div>
          {lastFetchedAt != null && (
            <div className="text-text-muted">Last fetched {formatLastFetched(lastFetchedAt)}</div>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  if (!hasAhead && !hasBehind) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "flex items-center text-[10px] font-mono tabular-nums",
            containerGapClass,
            isFetchInFlight && "animate-pulse-immediate"
          )}
          data-testid="upstream-sync-indicator"
          data-fetch-in-flight={isFetchInFlight ? "true" : undefined}
        >
          {hasAhead && <span className="text-status-success">↑{aheadCount}</span>}
          {hasBehind && <span className="text-status-warning">↓{behindCount}</span>}
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
        {fetchNetworkFailed && (
          <div className="text-status-warning/80" data-testid="upstream-sync-network-warning">
            Couldn't reach origin
          </div>
        )}
        {lastFetchedAt != null && (
          <div className="text-text-muted">Last fetched {formatLastFetched(lastFetchedAt)}</div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
