import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { Clock, CloudOff, CornerDownRight, GitPullRequest } from "lucide-react";
import type { CIStatus } from "@shared/types/forge";
import type { NormalizedPRState } from "@shared/types/forge";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { usePRTooltip } from "@/hooks/useGitHubTooltip";
import { useGitHubBadgeTooltip } from "./hooks/useGitHubBadgeTooltip";
import { useGitHubBadgeFreshness } from "./hooks/useGitHubBadgeFreshness";
import { badgeFreshnessSuffix } from "@/components/Layout/FreshnessUtils";
import { PRTooltipContent, TooltipLoading, TokenMissingTooltip } from "./GitHubTooltipContent";
import { getCIStatusVisual } from "@/lib/worktreeCIStatus";

interface PRBadgeProps {
  prNumber: number;
  prState?: NormalizedPRState;
  prCiStatus?: CIStatus | null;
  isSubordinate: boolean;
  worktreePath: string;
  onOpen?: () => void;
  isActive?: boolean;
  underlineOnHover?: boolean;
  rowLastUpdatedAt?: number;
  /** Service-wide PR detection circuit breaker tripped — this rollup may be stale. */
  prDetectionPaused?: boolean;
  /**
   * Render as the card's primary headline (larger text, PR title shown). Used
   * for worktrees created from the PR dropdown (#8888), mirroring IssueBadge.
   */
  isHeadline?: boolean;
  /** PR title to show when `isHeadline` is set. */
  prTitle?: string;
}

export function PRBadge({
  prNumber,
  prState,
  prCiStatus,
  isSubordinate,
  worktreePath,
  onOpen,
  isActive,
  underlineOnHover,
  rowLastUpdatedAt,
  prDetectionPaused,
  isHeadline,
  prTitle,
}: PRBadgeProps) {
  // Mirror IssueBadge: when a freshly-set PR number has no title yet, suppress
  // the raw "#NNN" fallback for the first 400ms (Doherty) rather than flashing
  // the number while the title fetch is in-flight.
  "use no memo";

  const { data, loading, error, missingToken, fetchTooltip, reset } = usePRTooltip(
    worktreePath,
    prNumber
  );

  const prevPrNumber = useRef<number | undefined>(undefined);
  const isColdTitleGap = isHeadline === true && !prTitle && prNumber !== prevPrNumber.current;
  const showColdFallback = useDohertyGate(isColdTitleGap);
  const showTooltipLoading = useDohertyGate(loading);
  useEffect(() => {
    prevPrNumber.current = prNumber;
  }, [prNumber]);

  const { isOpen, handleOpenChange, handleClick } = useGitHubBadgeTooltip({
    fetchTooltip,
    reset,
    missingToken,
    isActive: isActive ?? false,
    onOpen,
  });

  const { freshnessCause, cacheLastUpdatedAt, rateLimitResetAt, now } = useGitHubBadgeFreshness(
    "pr",
    rowLastUpdatedAt
  );

  const prStateColor =
    prState === "merged"
      ? "text-pr-merged"
      : prState === "closed" || prState === "declined"
        ? "text-pr-closed"
        : "text-pr-open";

  const prStateLabel =
    prState === "merged"
      ? "merged"
      : prState === "closed" || prState === "declined"
        ? "closed"
        : "open";

  const ciVisual = getCIStatusVisual(prCiStatus);

  const showStaleGlyph = freshnessCause === "stale" && !missingToken;
  const showPausedGlyph =
    (freshnessCause === "rate-limit" ||
      freshnessCause === "circuit-breaker" ||
      (prDetectionPaused ?? false)) &&
    !missingToken;

  const ariaLabel = missingToken
    ? "Configure GitHub token to see PR details"
    : (isHeadline && prTitle
        ? `Open pull request #${prNumber}: ${prTitle}`
        : ciVisual
          ? `Open ${prStateLabel} pull request #${prNumber} on GitHub — ${ciVisual.ariaLabel}`
          : `Open ${prStateLabel} pull request #${prNumber} on GitHub`) +
      (freshnessCause === "rate-limit"
        ? " — GitHub rate limited"
        : freshnessCause === "circuit-breaker" || (prDetectionPaused ?? false)
          ? " — PR detection paused"
          : "");

  const freshnessSuffixStr = useMemo(
    () =>
      badgeFreshnessSuffix(
        freshnessCause,
        rowLastUpdatedAt ?? cacheLastUpdatedAt,
        now,
        rateLimitResetAt
      ),
    [freshnessCause, rowLastUpdatedAt, cacheLastUpdatedAt, rateLimitResetAt, now]
  );

  return (
    <Tooltip open={isOpen} onOpenChange={handleOpenChange} delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          data-no-dnd
          className={cn(
            "flex items-center gap-1 text-left cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent min-w-0",
            isHeadline ? "gap-1.5 text-[13px]" : "text-xs"
          )}
          aria-disabled={!isActive || undefined}
          aria-label={ariaLabel}
        >
          {isSubordinate && (
            <CornerDownRight
              className={cn(
                "w-3 h-3 shrink-0",
                missingToken ? "grayscale opacity-50" : "text-text-muted"
              )}
              aria-hidden="true"
            />
          )}
          <GitPullRequest
            className={cn(
              "shrink-0",
              isHeadline ? "w-3.5 h-3.5" : "w-3 h-3",
              missingToken ? "grayscale opacity-50" : prStateColor
            )}
            aria-hidden="true"
          />
          {isHeadline ? (
            <span
              className={cn(
                "truncate flex-1 min-w-0",
                underlineOnHover && "hover:underline",
                missingToken
                  ? "text-text-muted"
                  : isActive
                    ? "text-text-primary font-medium"
                    : "text-text-secondary font-medium"
              )}
            >
              {prTitle ||
                (isColdTitleGap && !showColdFallback ? null : (
                  <span
                    className={cn("font-mono", missingToken ? "text-text-muted" : prStateColor)}
                  >
                    #{prNumber}
                  </span>
                ))}
            </span>
          ) : (
            <span
              className={cn(
                "font-mono",
                underlineOnHover && "hover:underline",
                missingToken ? "text-text-muted" : prStateColor
              )}
            >
              #{prNumber}
            </span>
          )}
          {ciVisual && !missingToken && (
            <span
              className="inline-flex items-center justify-center w-3 h-3 shrink-0"
              aria-hidden="true"
            >
              {ciVisual.kind === "icon" ? (
                <ciVisual.Icon className={cn("w-3 h-3", ciVisual.colorClass)} />
              ) : (
                <span className={cn("block w-2 h-2 rounded-full", ciVisual.colorClass)} />
              )}
            </span>
          )}
          {showStaleGlyph && (
            <Clock
              className="w-3 h-3 shrink-0 text-text-muted"
              strokeWidth={2.5}
              aria-hidden="true"
            />
          )}
          {showPausedGlyph && (
            <CloudOff className="w-3 h-3 shrink-0 text-text-muted" aria-hidden="true" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="p-3">
        {missingToken ? (
          <TokenMissingTooltip type="pr" />
        ) : showTooltipLoading ? (
          <TooltipLoading />
        ) : data ? (
          <PRTooltipContent data={data} />
        ) : error ? (
          <span className="text-xs text-text-secondary">Failed to load PR details</span>
        ) : (
          <span className="text-xs text-text-secondary">PR #{prNumber}</span>
        )}
        {freshnessSuffixStr && (
          <span className="block text-[11px] text-text-muted mt-1">{freshnessSuffixStr}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
