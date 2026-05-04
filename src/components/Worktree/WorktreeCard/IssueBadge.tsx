import { memo } from "react";
import { cn } from "@/lib/utils";
import { CircleDot } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { useIssueTooltip } from "@/hooks/useGitHubTooltip";
import { useGitHubBadgeTooltip } from "./hooks/useGitHubBadgeTooltip";
import { IssueTooltipContent, TooltipLoading, TokenMissingTooltip } from "./GitHubTooltipContent";

interface IssueBadgeProps {
  issueNumber: number;
  issueTitle?: string;
  worktreePath: string;
  onOpen?: () => void;
  isHeadline?: boolean;
  isActive?: boolean;
  underlineOnHover?: boolean;
}

export const IssueBadge = memo(function IssueBadge({
  issueNumber,
  issueTitle,
  worktreePath,
  onOpen,
  isHeadline,
  isActive,
  underlineOnHover,
}: IssueBadgeProps) {
  const { data, loading, error, missingToken, fetchTooltip, reset } = useIssueTooltip(
    worktreePath,
    issueNumber
  );

  const { isOpen, handleOpenChange, handleClick } = useGitHubBadgeTooltip({
    fetchTooltip,
    reset,
    missingToken,
    isActive: isActive ?? false,
    onOpen,
  });

  return (
    <Tooltip open={isOpen} onOpenChange={handleOpenChange} delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          className={cn(
            "flex items-center gap-1.5 text-left cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent min-w-0",
            isHeadline ? "text-[13px]" : "text-xs",
            missingToken && "opacity-60"
          )}
          aria-disabled={!isActive || undefined}
          aria-label={
            missingToken
              ? "Configure GitHub token to see issue details"
              : issueTitle
                ? `Open issue #${issueNumber}: ${issueTitle}`
                : `Open issue #${issueNumber} on GitHub`
          }
        >
          <CircleDot
            className={cn("text-github-open shrink-0", isHeadline ? "w-3.5 h-3.5" : "w-3 h-3")}
            aria-hidden="true"
          />
          <span
            className={cn(
              "truncate flex-1 min-w-0",
              underlineOnHover && "hover:underline",
              isHeadline
                ? isActive
                  ? "text-text-primary font-medium"
                  : "text-text-secondary font-medium"
                : "text-text-primary/90"
            )}
          >
            {issueTitle || <span className="text-github-open font-mono">#{issueNumber}</span>}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="p-3">
        {missingToken ? (
          <TokenMissingTooltip type="issue" />
        ) : loading ? (
          <TooltipLoading />
        ) : data ? (
          <IssueTooltipContent data={data} />
        ) : error ? (
          <span className="text-xs text-text-secondary">Failed to load issue details</span>
        ) : (
          <span className="text-xs text-text-secondary">Issue #{issueNumber}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
});
