import { cn } from "@/lib/utils";
import { CircleDot, CloudOff } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { useIssueTooltip } from "@/hooks/useForgeTooltip";
import { useForgeBadgeTooltip } from "./hooks/useForgeBadgeTooltip";
import { useColdNumberGap } from "./hooks/useColdNumberGap";
import { useForgeBadgeFreshness } from "./hooks/useForgeBadgeFreshness";
import { freshnessClass } from "@/components/Layout/FreshnessUtils";
import {
  IssueTooltipContent,
  TokenMissingTooltip,
  describeIssueTooltip,
  TooltipFallback,
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
  const hideColdNumber = useColdNumberGap(issueNumber, issueTitle);

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
            freshnessClass(freshnessLevel),
            isHeadline ? "gap-1.5 text-sm leading-[inherit]" : "text-xs"
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
              missingCredential ? "text-text-secondary" : "text-pr-open"
            )}
            aria-hidden="true"
          />
          <span
            className={cn(
              "truncate flex-1 min-w-0",
              underlineOnHover && "hover:underline",
              missingCredential
                ? "text-text-secondary"
                : isHeadline
                  ? isActive
                    ? "text-text-primary font-medium"
                    : "text-text-secondary font-medium"
                  : "text-text-primary"
            )}
          >
            {issueTitle ||
              (hideColdNumber ? null : (
                <span
                  className={cn(
                    "font-mono",
                    missingCredential ? "text-text-secondary" : "text-pr-open"
                  )}
                >
                  #{issueNumber}
                </span>
              ))}
          </span>
          {showPausedGlyph && (
            <CloudOff className="w-3 h-3 shrink-0 text-text-secondary" aria-hidden="true" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        className="p-3"
        aria-label={data && !missingCredential ? describeIssueTooltip(data, freshness) : undefined}
      >
        {missingCredential ? (
          <TokenMissingTooltip type="issue" />
        ) : data ? (
          <IssueTooltipContent data={data} freshness={freshness} />
        ) : (
          <TooltipFallback
            type="issue"
            number={issueNumber}
            title={issueTitle}
            status={loading ? "loading" : error ? "failed" : "idle"}
            freshness={freshness}
          />
        )}
      </TooltipContent>
    </Tooltip>
  );
}
