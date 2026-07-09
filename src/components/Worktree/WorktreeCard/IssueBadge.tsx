import { cn } from "@/lib/utils";
import { CircleDot, CloudOff } from "lucide-react";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { useIssueTooltip } from "@/hooks/useForgeTooltip";
import { useForgeBadgeTooltip } from "./hooks/useForgeBadgeTooltip";
import { useColdNumberGap } from "./hooks/useColdNumberGap";
import { useForgeBadgeFreshness } from "./hooks/useForgeBadgeFreshness";
import { freshnessClass } from "@/components/Layout/FreshnessUtils";
import {
  IssueTooltipContent,
  TooltipLoading,
  TokenMissingTooltip,
  FreshnessMetaItem,
  type TooltipFreshness,
} from "./ForgeTooltipContent";

interface IssueBadgeProps {
  issueNumber: number;
  issueTitle?: string;
  worktreePath: string;
  onOpen?: () => void;
  isHeadline?: boolean;
  isActive?: boolean;
  underlineOnHover?: boolean;
}

export function IssueBadge({
  issueNumber,
  issueTitle,
  worktreePath,
  onOpen,
  isHeadline,
  isActive,
  underlineOnHover,
}: IssueBadgeProps) {
  const { data, loading, error, missingCredential, providerId, fetchTooltip, reset } =
    useIssueTooltip(worktreePath, issueNumber);

  const { isOpen, handleOpenChange, handleClick } = useForgeBadgeTooltip({
    fetchTooltip,
    reset,
    missingCredential,
    providerId,
    isActive: isActive ?? false,
    onOpen,
  });

  // Suppress the raw "#NNN" monospace fallback during the brief window where
  // a *freshly-set* issue number has no title yet (the forge title fetch is
  // in-flight, ~100–500ms). Per the Doherty Threshold, show nothing for the
  // first 400ms rather than flashing the number, then fall through (#8079).
  // Title preservation for *unchanged* issue numbers is handled upstream in
  // the store, so this gate only fires on genuine issue-number transitions.
  const isColdTitleGap = useColdNumberGap(issueNumber, issueTitle);
  const showColdFallback = useDohertyGate(isColdTitleGap);
  const showTooltipLoading = useDohertyGate(loading);

  const { freshnessLevel, freshnessCause, rateLimitResetAt, now } = useForgeBadgeFreshness("issue");

  const freshness: TooltipFreshness = { cause: freshnessCause, now, rateLimitResetAt };

  const showPausedGlyph = freshnessCause === "rate-limit" && !missingCredential;

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
            freshnessClass(freshnessLevel),
            isHeadline ? "gap-1.5 text-[13px]" : "text-xs"
          )}
          aria-disabled={!isActive || undefined}
          aria-label={
            missingCredential
              ? "Add a forge access token to see issue details"
              : issueTitle
                ? `Open issue #${issueNumber}: ${issueTitle}`
                : `Open issue #${issueNumber}`
          }
        >
          <CircleDot
            className={cn(
              "shrink-0",
              isHeadline ? "w-3.5 h-3.5" : "w-3 h-3",
              missingCredential ? "text-text-muted" : "text-pr-open"
            )}
            aria-hidden="true"
          />
          <span
            className={cn(
              "truncate flex-1 min-w-0",
              underlineOnHover && "hover:underline",
              missingCredential
                ? "text-text-muted"
                : isHeadline
                  ? isActive
                    ? "text-text-primary font-medium"
                    : "text-text-secondary font-medium"
                  : "text-text-primary"
            )}
          >
            {issueTitle ||
              (isColdTitleGap && !showColdFallback ? null : (
                <span
                  className={cn(
                    "font-mono",
                    missingCredential ? "text-text-muted" : "text-pr-open"
                  )}
                >
                  #{issueNumber}
                </span>
              ))}
          </span>
          {showPausedGlyph && (
            <CloudOff className="w-3 h-3 shrink-0 text-text-muted" aria-hidden="true" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="p-3">
        {missingCredential ? (
          <TokenMissingTooltip type="issue" />
        ) : showTooltipLoading ? (
          <TooltipLoading />
        ) : data ? (
          <IssueTooltipContent data={data} freshness={freshness} />
        ) : error ? (
          <span className="text-xs text-text-secondary">Failed to load issue details</span>
        ) : (
          <span className="text-xs text-text-secondary">Issue #{issueNumber}</span>
        )}
        {!data && (
          <FreshnessMetaItem freshness={freshness} className="text-[11px] text-text-muted mt-1" />
        )}
      </TooltipContent>
    </Tooltip>
  );
}
