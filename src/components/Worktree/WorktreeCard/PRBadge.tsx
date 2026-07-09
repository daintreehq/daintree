import { cn } from "@/lib/utils";
import { CloudOff, CornerDownRight, GitPullRequest } from "lucide-react";
import type { CIStatus } from "@shared/types/forge";
import type { NormalizedPRState } from "@shared/types/forge";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { usePRTooltip } from "@/hooks/useForgeTooltip";
import { useForgeBadgeTooltip } from "./hooks/useForgeBadgeTooltip";
import { useColdNumberGap } from "./hooks/useColdNumberGap";
import { useForgeBadgeFreshness } from "./hooks/useForgeBadgeFreshness";
import {
  PRTooltipContent,
  TooltipLoading,
  TokenMissingTooltip,
  FreshnessMetaItem,
  type TooltipFreshness,
} from "./ForgeTooltipContent";
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
  prDetectionPaused,
  isHeadline,
  prTitle,
}: PRBadgeProps) {
  const { data, loading, error, missingCredential, providerId, fetchTooltip, reset } = usePRTooltip(
    worktreePath,
    prNumber
  );

  // Mirror IssueBadge: when a freshly-set PR number has no title yet, suppress
  // the raw "#NNN" fallback for the first 400ms (Doherty) rather than flashing
  // the number while the title fetch is in-flight.
  const isColdTitleGap = useColdNumberGap(prNumber, prTitle, isHeadline === true);
  const showColdFallback = useDohertyGate(isColdTitleGap);
  const showTooltipLoading = useDohertyGate(loading);

  const { isOpen, handleOpenChange, handleClick } = useForgeBadgeTooltip({
    fetchTooltip,
    reset,
    missingCredential,
    providerId,
    isActive: isActive ?? false,
    onOpen,
  });

  const { freshnessCause, rateLimitResetAt, now } = useForgeBadgeFreshness("pr");

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

  const showPausedGlyph =
    (freshnessCause === "rate-limit" ||
      freshnessCause === "circuit-breaker" ||
      (prDetectionPaused ?? false)) &&
    !missingCredential;

  const ariaLabel = missingCredential
    ? "Add a forge access token to see PR details"
    : (isHeadline && prTitle
        ? `Open pull request #${prNumber}: ${prTitle}`
        : ciVisual
          ? `Open ${prStateLabel} pull request #${prNumber} — ${ciVisual.ariaLabel}`
          : `Open ${prStateLabel} pull request #${prNumber}`) +
      (freshnessCause === "rate-limit"
        ? " — forge rate limited"
        : freshnessCause === "circuit-breaker" || (prDetectionPaused ?? false)
          ? " — PR detection paused"
          : "");

  const freshness: TooltipFreshness = { cause: freshnessCause, now, rateLimitResetAt };

  return (
    <Tooltip
      open={isOpen}
      onOpenChange={handleOpenChange}
      delayDuration={300}
      autoDismiss={false}
      // Rich hover card whose body IS the content — exempt from the global
      // dialog-transition dismissal (issue #11030).
      dismissOnDialogTransition={false}
    >
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
              className={cn("w-3 h-3 shrink-0 text-text-muted")}
              aria-hidden="true"
            />
          )}
          <GitPullRequest
            className={cn(
              "shrink-0",
              isHeadline ? "w-3.5 h-3.5" : "w-3 h-3",
              missingCredential ? "text-text-muted" : prStateColor
            )}
            aria-hidden="true"
          />
          {isHeadline ? (
            <span
              className={cn(
                "truncate flex-1 min-w-0",
                underlineOnHover && "hover:underline",
                missingCredential
                  ? "text-text-muted"
                  : isActive
                    ? "text-text-primary font-medium"
                    : "text-text-secondary font-medium"
              )}
            >
              {prTitle ||
                (isColdTitleGap && !showColdFallback ? null : (
                  <span
                    className={cn(
                      "font-mono",
                      missingCredential ? "text-text-muted" : prStateColor
                    )}
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
                missingCredential ? "text-text-muted" : prStateColor
              )}
            >
              #{prNumber}
            </span>
          )}
          {ciVisual && !missingCredential && (
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
          {showPausedGlyph && (
            <CloudOff className="w-3 h-3 shrink-0 text-text-muted" aria-hidden="true" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="p-3">
        {missingCredential ? (
          <TokenMissingTooltip type="pr" />
        ) : showTooltipLoading ? (
          <TooltipLoading />
        ) : data ? (
          <PRTooltipContent data={data} freshness={freshness} />
        ) : error ? (
          <span className="text-xs text-text-secondary">Failed to load PR details</span>
        ) : (
          <span className="text-xs text-text-secondary">PR #{prNumber}</span>
        )}
        {!data && (
          <FreshnessMetaItem freshness={freshness} className="text-[11px] text-text-muted mt-1" />
        )}
      </TooltipContent>
    </Tooltip>
  );
}
