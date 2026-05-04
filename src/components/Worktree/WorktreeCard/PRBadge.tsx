import { memo } from "react";
import { cn } from "@/lib/utils";
import { CornerDownRight, GitPullRequest } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { usePRTooltip } from "@/hooks/useGitHubTooltip";
import { useGitHubBadgeTooltip } from "./hooks/useGitHubBadgeTooltip";
import { PRTooltipContent, TooltipLoading, TokenMissingTooltip } from "./GitHubTooltipContent";

interface PRBadgeProps {
  prNumber: number;
  prState?: "open" | "merged" | "closed";
  isSubordinate: boolean;
  worktreePath: string;
  onOpen?: () => void;
  isActive?: boolean;
  underlineOnHover?: boolean;
}

export const PRBadge = memo(function PRBadge({
  prNumber,
  prState,
  isSubordinate,
  worktreePath,
  onOpen,
  isActive,
  underlineOnHover,
}: PRBadgeProps) {
  const { data, loading, error, missingToken, fetchTooltip, reset } = usePRTooltip(
    worktreePath,
    prNumber
  );

  const { isOpen, handleOpenChange, handleClick } = useGitHubBadgeTooltip({
    fetchTooltip,
    reset,
    missingToken,
    isActive: isActive ?? false,
    onOpen,
  });

  const prStateColor =
    prState === "merged"
      ? "text-github-merged"
      : prState === "closed"
        ? "text-github-closed"
        : "text-github-open";

  const prStateLabel = prState === "merged" ? "merged" : prState === "closed" ? "closed" : "open";

  return (
    <Tooltip open={isOpen} onOpenChange={handleOpenChange} delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          className={cn(
            "flex items-center gap-1 text-xs text-left cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent min-w-0",
            missingToken && "opacity-60"
          )}
          aria-disabled={!isActive || undefined}
          aria-label={
            missingToken
              ? "Configure GitHub token to see PR details"
              : `Open ${prStateLabel} pull request #${prNumber} on GitHub`
          }
        >
          {isSubordinate && (
            <CornerDownRight className="w-3 h-3 text-text-muted shrink-0" aria-hidden="true" />
          )}
          <GitPullRequest className={cn("w-3 h-3 shrink-0", prStateColor)} aria-hidden="true" />
          <span className={cn("font-mono", underlineOnHover && "hover:underline", prStateColor)}>
            #{prNumber}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="p-3">
        {missingToken ? (
          <TokenMissingTooltip type="pr" />
        ) : loading ? (
          <TooltipLoading />
        ) : data ? (
          <PRTooltipContent data={data} />
        ) : error ? (
          <span className="text-xs text-text-secondary">Failed to load PR details</span>
        ) : (
          <span className="text-xs text-text-secondary">PR #{prNumber}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
});
