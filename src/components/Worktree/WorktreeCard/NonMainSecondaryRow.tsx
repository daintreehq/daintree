import { cn } from "@/lib/utils";
import { BranchLabel } from "../BranchLabel";
import { UpstreamSyncBadge } from "./UpstreamSyncBadge";
import { IssueBadge } from "./IssueBadge";
import { PRBadge } from "./PRBadge";
import { FileText } from "lucide-react";
import type { WorktreeState } from "@/types";

interface NonMainSecondaryRowProps {
  worktree: WorktreeState;
  branchLabel: string;
  isActive: boolean;
  isMuted?: boolean;
  underlineOnHover: boolean;
  hasUpstreamDelta: boolean;
  hasAuthFailedSignIn: boolean;
  hasIssueTitle: boolean;
  hasPlanFile: boolean;
  badges: {
    onOpenIssue?: () => void;
    onOpenPR?: () => void;
    onOpenPlan?: () => void;
  };
}

export function NonMainSecondaryRow({
  worktree,
  branchLabel,
  isActive,
  isMuted,
  underlineOnHover,
  hasUpstreamDelta,
  hasAuthFailedSignIn,
  hasIssueTitle,
  hasPlanFile,
  badges,
}: NonMainSecondaryRowProps) {
  return (
    <div className="flex flex-col gap-0.5 mt-1.5">
      {worktree.issueNumber && !hasIssueTitle && (
        <IssueBadge
          issueNumber={worktree.issueNumber}
          worktreePath={worktree.path}
          onOpen={badges.onOpenIssue}
          isActive={isActive}
          underlineOnHover={underlineOnHover}
        />
      )}
      {worktree.prNumber && worktree.prState !== "closed" && (
        <PRBadge
          prNumber={worktree.prNumber}
          prState={worktree.prState}
          isSubordinate={!!worktree.issueNumber}
          worktreePath={worktree.path}
          onOpen={badges.onOpenPR}
          isActive={isActive}
          underlineOnHover={underlineOnHover}
        />
      )}
      {(hasUpstreamDelta || hasAuthFailedSignIn) && (
        <UpstreamSyncBadge
          aheadCount={worktree.aheadCount}
          behindCount={worktree.behindCount}
          isFetchInFlight={Boolean(worktree.isFetchInFlight)}
          lastFetchedAt={worktree.lastFetchedAt}
          fetchAuthFailed={Boolean(worktree.fetchAuthFailed)}
          fetchNetworkFailed={Boolean(worktree.fetchNetworkFailed)}
          isGitHubRemote={Boolean(worktree.isGitHubRemote)}
          containerGapClass="gap-1.5"
        />
      )}
      {hasIssueTitle && (
        <BranchLabel
          label={branchLabel}
          isActive={isActive}
          isMuted={isMuted}
          isMainWorktree={false}
        />
      )}
      {hasPlanFile && badges.onOpenPlan && (
        <button
          type="button"
          onClick={() => {
            if (isActive) badges.onOpenPlan?.();
          }}
          className="flex items-center gap-1 text-xs text-left cursor-pointer transition-colors text-daintree-text/70 hover:text-daintree-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
          aria-disabled={!isActive || undefined}
          aria-label="View agent plan file"
        >
          <FileText className="w-3 h-3 shrink-0 text-daintree-text/50" aria-hidden="true" />
          <span className={cn("font-mono", underlineOnHover && "hover:underline")}>
            {worktree.planFilePath ?? "Plan"}
          </span>
        </button>
      )}
    </div>
  );
}
