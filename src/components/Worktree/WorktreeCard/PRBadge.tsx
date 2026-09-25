import { cn } from "@/lib/utils";
import { CloudOff, CornerDownRight } from "lucide-react";
import { getPrStateColor, getPrStateGlyph } from "@/lib/prStateGlyph";
import type { CIStatus } from "@shared/types/forge";
import type { NormalizedPRState } from "@shared/types/forge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { usePRTooltip } from "@/hooks/useForgeTooltip";
import { useForgeBadgeTooltip } from "./hooks/useForgeBadgeTooltip";
import { useColdNumberGap } from "./hooks/useColdNumberGap";
import { useForgeBadgeFreshness } from "./hooks/useForgeBadgeFreshness";
import {
  PRTooltipContent,
  TokenMissingTooltip,
  describePRTooltip,
  TooltipFallback,
  HOVER_CARD_EVENT_FENCE,
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
  const hideColdNumber = useColdNumberGap(prNumber, prTitle, isHeadline === true);

  const { isOpen, handleOpenChange, handleClick } = useForgeBadgeTooltip({
    fetchTooltip,
    reset,
    missingCredential,
    providerId,
    isActive: isActive ?? false,
    onOpen,
  });

  const { freshnessCause, rateLimitResetAt, now } = useForgeBadgeFreshness("pr");

  // Shape AND colour, not colour alone: `getPrStateGlyph` is shared with the
  // Review Hub chip and the forge list so the three cannot drift.
  const PrStateGlyph = getPrStateGlyph(prState);
  const prStateColor = getPrStateColor(prState);

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
    ? `Pull request #${prNumber}${isHeadline && prTitle ? `: ${prTitle}` : ""}. Add a forge access token to see PR details`
    : `Open ${prStateLabel} pull request #${prNumber}` +
      (isHeadline && prTitle ? `: ${prTitle}` : "") +
      (ciVisual ? ` — ${ciVisual.ariaLabel}` : "") +
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
      // The app-wide provider makes tooltip content pass-through. A card this
      // size must stay up while the pointer crosses onto it to read it (WCAG
      // SC 1.4.13, hoverable), so this one opts back in.
      disableHoverableContent={false}
    >
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          data-no-dnd
          className={cn(
            "flex items-center gap-1 text-left cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary min-w-0",
            isHeadline ? "gap-1.5 text-sm leading-[inherit]" : "text-xs"
          )}
          aria-disabled={!isActive || undefined}
          aria-label={ariaLabel}
        >
          {isSubordinate && (
            <CornerDownRight className="w-3 h-3 shrink-0 text-text-secondary" aria-hidden="true" />
          )}
          <PrStateGlyph
            className={cn(
              "shrink-0",
              isHeadline ? "w-3.5 h-3.5" : "w-3 h-3",
              missingCredential ? "text-text-secondary" : prStateColor
            )}
            aria-hidden="true"
          />
          {isHeadline ? (
            <span
              className={cn(
                "truncate flex-1 min-w-0",
                underlineOnHover && "hover:underline",
                missingCredential
                  ? "text-text-secondary"
                  : isActive
                    ? "text-text-primary font-medium"
                    : "text-text-secondary font-medium"
              )}
            >
              {prTitle ||
                (hideColdNumber ? null : (
                  <span
                    className={cn(
                      "font-mono",
                      missingCredential ? "text-text-secondary" : prStateColor
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
                missingCredential ? "text-text-secondary" : prStateColor
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
                <span
                  className={cn("status-mark block w-2 h-2 rounded-full", ciVisual.colorClass)}
                />
              )}
            </span>
          )}
          {showPausedGlyph && (
            <CloudOff className="w-3 h-3 shrink-0 text-text-secondary" aria-hidden="true" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        className="p-3"
        {...HOVER_CARD_EVENT_FENCE}
        aria-label={
          data && !missingCredential
            ? describePRTooltip(data, freshness, prCiStatus, {
                // The subordinate badge shows only the number, so the card's
                // description is the only place its title is spoken.
                includeTitle: !(isHeadline && prTitle),
              })
            : undefined
        }
      >
        {missingCredential ? (
          <TokenMissingTooltip type="pr" />
        ) : data ? (
          <PRTooltipContent data={data} freshness={freshness} ciStatus={prCiStatus} />
        ) : (
          <TooltipFallback
            type="pr"
            number={prNumber}
            title={prTitle}
            prState={prState}
            ciStatus={prCiStatus}
            status={loading ? "loading" : error ? "failed" : "idle"}
            freshness={freshness}
          />
        )}
      </TooltipContent>
    </Tooltip>
  );
}
