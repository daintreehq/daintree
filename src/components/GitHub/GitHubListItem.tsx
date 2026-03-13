import type { MouseEvent } from "react";
import {
  CircleDot,
  CheckCircle2,
  GitPullRequest,
  GitMerge,
  GitPullRequestClosed,
  GitBranch,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTimeAgo } from "@/utils/timeAgo";
import { actionService } from "@/services/ActionService";
import type {
  GitHubIssue,
  GitHubPR,
  GitHubLabel,
  GitHubPRCIStatus,
} from "@shared/types/github";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

interface GitHubListItemProps {
  item: GitHubIssue | GitHubPR;
  type: "issue" | "pr";
  onCreateWorktree?: (item: GitHubIssue | GitHubPR) => void;
  onSwitchToWorktree?: (worktreeId: string) => void;
  optionId?: string;
  isActive?: boolean;
}

function getStateIcon(state: string, type: "issue" | "pr") {
  if (type === "issue") {
    return state === "OPEN" ? CircleDot : CheckCircle2;
  }
  if (state === "MERGED") return GitMerge;
  if (state === "OPEN") return GitPullRequest;
  return GitPullRequestClosed;
}

function getStateColor(state: string, isDraft?: boolean): string {
  if (isDraft) return "text-github-draft";
  if (state === "OPEN") return "text-github-open";
  if (state === "MERGED") return "text-github-merged";
  if (state === "CLOSED") return "text-github-closed";
  return "text-muted-foreground";
}

function isPR(item: GitHubIssue | GitHubPR): item is GitHubPR {
  return "isDraft" in item;
}

function buildTooltipLines(
  item: GitHubIssue | GitHubPR,
  type: "issue" | "pr",
  isItemPR: boolean
): string[] {
  const lines: string[] = ["Open in GitHub"];

  if (isItemPR && (item as GitHubPR).headRefName) {
    lines.push(`Branch: ${(item as GitHubPR).headRefName}`);
  }

  if (!isItemPR && "linkedPR" in item && item.linkedPR) {
    const lpr = item.linkedPR;
    lines.push(`Linked PR: #${lpr.number} (${lpr.state.toLowerCase()})`);
  }

  const issueLabels: GitHubLabel[] = !isItemPR && "labels" in item ? (item.labels ?? []) : [];
  if (issueLabels.length > 0) {
    lines.push(`Labels: ${issueLabels.map((l) => l.name).join(", ")}`);
  }

  return lines;
}

function getCIStatusInfo(status: GitHubPRCIStatus): { color: string; tooltip: string } {
  switch (status) {
    case "SUCCESS":
      return { color: "bg-status-success", tooltip: "All checks passed" };
    case "PENDING":
    case "EXPECTED":
      return { color: "bg-status-warning", tooltip: "Checks pending" };
    case "FAILURE":
    case "ERROR":
      return { color: "bg-status-error", tooltip: "Checks failing" };
    default:
      return { color: "bg-muted-foreground", tooltip: "Check status unknown" };
  }
}

export function GitHubListItem({
  item,
  type,
  onCreateWorktree,
  onSwitchToWorktree,
  optionId,
  isActive,
}: GitHubListItemProps) {
  const isItemPR = isPR(item);
  const StateIcon = getStateIcon(item.state, type);
  const stateColor = getStateColor(item.state, isItemPR && item.isDraft);

  const matchedWorktree = useWorktreeDataStore((s) => {
    for (const wt of s.worktrees.values()) {
      if (type === "issue" ? wt.issueNumber === item.number : wt.prNumber === item.number)
        return wt;
    }
    return undefined;
  });
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const hasWorktree = matchedWorktree !== undefined;
  const isActiveWorktree = hasWorktree && matchedWorktree.id === activeWorktreeId;

  const handleOpenExternal = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    void actionService.dispatch("system.openExternal", { url: item.url }, { source: "user" });
  };

  const handleCreateWorktree = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (onCreateWorktree) {
      onCreateWorktree(item);
    }
  };

  const handleSwitchToWorktree = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (onSwitchToWorktree && matchedWorktree) {
      onSwitchToWorktree(matchedWorktree.id);
    }
  };

  const tooltipLines = buildTooltipLines(item, type, isItemPR);
  const isForkPR = isItemPR && (item as GitHubPR).isFork === true;

  return (
    <div
      id={optionId}
      role="option"
      aria-selected={isActive}
      className={cn(
        "p-3 hover:bg-muted/50 transition-colors group cursor-default",
        isActive && "bg-muted/50"
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn("mt-0.5 shrink-0", stateColor)}>
          <StateIcon className="h-4 w-4" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleOpenExternal}
                    className="text-sm font-medium text-foreground truncate hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 cursor-pointer text-left"
                    aria-label={`Open ${type} "${item.title}" in GitHub`}
                  >
                    {item.title}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {tooltipLines.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {isItemPR && item.state === "OPEN" && item.ciStatus && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        "shrink-0 w-2 h-2 rounded-full",
                        getCIStatusInfo(item.ciStatus).color
                      )}
                      aria-label={getCIStatusInfo(item.ciStatus).tooltip}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {getCIStatusInfo(item.ciStatus).tooltip}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <span className="text-xs text-muted-foreground shrink-0">#{item.number}</span>
            {hasWorktree && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        "shrink-0",
                        isActiveWorktree ? "text-canopy-accent" : "text-muted-foreground"
                      )}
                    >
                      <GitBranch className="w-3.5 h-3.5" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isActiveWorktree ? "Active worktree" : "Has worktree"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
            <span>{item.author.login}</span>
            <span>&middot;</span>
            <span>{formatTimeAgo(item.updatedAt)}</span>
          </div>
        </div>

        <div
          className={cn(
            "flex items-center gap-1 shrink-0 transition-opacity motion-reduce:transition-none",
            isActive
              ? "opacity-100"
              : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
          )}
        >
          {hasWorktree && !isActiveWorktree && onSwitchToWorktree && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleSwitchToWorktree}
                    tabIndex={isActive ? 0 : -1}
                    className="text-xs px-2 py-1 rounded hover:bg-muted transition-colors flex items-center gap-1 hover:text-canopy-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <GitBranch className="w-3 h-3" />
                    <span>Switch</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Switch to existing worktree</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {!hasWorktree && onCreateWorktree && item.state === "OPEN" && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCreateWorktree}
                    tabIndex={isActive ? 0 : -1}
                    disabled={isForkPR}
                    className={cn(
                      "text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isForkPR
                        ? "opacity-40 cursor-not-allowed"
                        : "hover:bg-muted hover:text-canopy-accent"
                    )}
                  >
                    <GitBranch className="w-3 h-3" />
                    <span>Create Worktree</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {isForkPR
                    ? "Not available for fork PRs — the branch is on a different remote"
                    : type === "issue"
                      ? "Create Worktree from Issue"
                      : "Create Worktree from PR"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>
    </div>
  );
}
