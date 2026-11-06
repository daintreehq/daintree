import { cn } from "@/lib/utils";
import { AlertTriangle, CloudOff, CornerDownRight } from "lucide-react";
import { GitMerge } from "@/components/icons";
import { describeMergeIntent, HEAD_MOVED_WHILE_ARMED_TEXT } from "@shared/utils/prMergeIntent";
import { getPrStateColor, getPrStateGlyph } from "@/lib/prStateGlyph";
import type { CIStatus, PRMergeIntent } from "@shared/types/forge";
import type { NormalizedPRState } from "@shared/types/forge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { usePRTooltip } from "@/hooks/useForgeTooltip";
import { useForgeBadgeTooltip } from "./hooks/useForgeBadgeTooltip";
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
  /** A merge the forge was asked to carry out later, whoever asked. */
  mergeIntent?: PRMergeIntent | null;
  /** The head moved while auto-merge stayed armed — commits that may land unreviewed. */
  headMovedWhileArmed?: boolean;
  isSubordinate: boolean;
  worktreePath: string;
  onOpen?: () => void;
  /** Names the worktree the PR belongs to in the reference's accessible name. */
  worktreeLabel?: string;
  /** Service-wide PR detection circuit breaker tripped — this rollup may be stale. */
  prDetectionPaused?: boolean;
  /**
   * PR title, shown in place of the bare number when given, which only the PR
   * a custom title displaced does (#13409).
   */
  prTitle?: string;
}

export function PRBadge({
  prNumber,
  prState,
  prCiStatus,
  mergeIntent,
  headMovedWhileArmed,
  isSubordinate,
  worktreePath,
  onOpen,
  worktreeLabel,
  prDetectionPaused,
  prTitle,
}: PRBadgeProps) {
  const { data, loading, error, missingCredential, providerId, fetchTooltip, reset } = usePRTooltip(
    worktreePath,
    prNumber
  );

  const { isOpen, handleOpenChange, handleClick } = useForgeBadgeTooltip({
    fetchTooltip,
    reset,
    missingCredential,
    providerId,
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
  const pendingMerge = prState === "open" ? (mergeIntent ?? null) : null;
  const headMoved = pendingMerge !== null && headMovedWhileArmed === true;
  const mergeNote = pendingMerge
    ? `${describeMergeIntent(pendingMerge)}${headMoved ? `. ${HEAD_MOVED_WHILE_ARMED_TEXT}` : ""}`
    : null;

  const showPausedGlyph =
    (freshnessCause === "rate-limit" ||
      freshnessCause === "circuit-breaker" ||
      (prDetectionPaused ?? false)) &&
    !missingCredential;

  const worktreeSuffix = worktreeLabel ? ` for worktree ${worktreeLabel}` : "";
  const ariaLabel = missingCredential
    ? `Pull request #${prNumber}${prTitle ? `: ${prTitle}` : ""}${worktreeSuffix}. Add a forge access token to see PR details`
    : `Open ${prStateLabel} pull request #${prNumber}` +
      (prTitle ? `: ${prTitle}` : "") +
      worktreeSuffix +
      (ciVisual ? ` — ${ciVisual.ariaLabel}` : "") +
      (mergeNote ? ` — ${mergeNote}` : "") +
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
          // A bounded control with its own plate, on the text's own x: the
          // negative margin cancels the padding the plate is drawn on.
          className="relative -mx-1 flex w-fit max-w-full min-w-0 items-center gap-1 rounded-[var(--radius-sm)] px-1 text-left text-xs cursor-pointer transition-colors hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']"
          aria-label={ariaLabel}
        >
          {isSubordinate && (
            <CornerDownRight className="w-3 h-3 shrink-0 text-text-secondary" aria-hidden="true" />
          )}
          <PrStateGlyph
            className={cn(
              "w-3 h-3 shrink-0",
              missingCredential ? "text-text-secondary" : prStateColor
            )}
            aria-hidden="true"
          />
          <span
            // The number in the line's own ink; the state glyph beside it
            // carries open/merged in hue, so a failing run's red mark is
            // the only colour on the line that argues with it.
            className="shrink-0 font-mono text-text-secondary"
          >
            #{prNumber}
          </span>
          {prTitle && (
            // The IssueBadge's subordinate title form, so a displaced PR and a
            // displaced issue read as the same kind of line.
            <span
              className={cn(
                "truncate min-w-0",
                missingCredential ? "text-text-secondary" : "text-text-primary"
              )}
            >
              {prTitle}
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
          {pendingMerge && !missingCredential && (
            <span
              className="inline-flex items-center justify-center w-3 h-3 shrink-0"
              aria-hidden="true"
              data-testid="pr-badge-merge-intent"
            >
              {headMoved ? (
                <AlertTriangle className="w-3 h-3 text-status-warning" />
              ) : (
                <GitMerge className="w-3 h-3 text-text-secondary" />
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
                // A badge drawn without its title shows only the number, so the
                // card's description is the only place that title is spoken.
                includeTitle: !prTitle,
              })
            : undefined
        }
      >
        {mergeNote && !missingCredential && (
          <p className="mb-2 max-w-xs text-xs text-text-secondary">{mergeNote}</p>
        )}
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
