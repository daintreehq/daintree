import { useState, useRef, useEffect } from "react";
import type { MouseEvent } from "react";
import {
  CircleDot,
  CheckCircle2,
  GitPullRequest,
  GitMerge,
  GitPullRequestClosed,
  GitBranch,
  MessageCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTimeAgo } from "@/utils/timeAgo";
import { actionService } from "@/services/ActionService";
import type { GitHubIssue, GitHubPR, GitHubLabel, LinkedPRInfo } from "@shared/types/github";
import { Avatar } from "@/components/ui/Avatar";
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

function getLabelStyles(color: string): React.CSSProperties {
  const hex = `#${color.replace(/^#/, "")}`;
  return {
    backgroundColor: `color-mix(in oklab, ${hex} 15%, transparent)`,
    border: `1px solid color-mix(in oklab, ${hex} 40%, transparent)`,
    color: `color-mix(in oklab, ${hex} 65%, white)`,
  };
}

function getPRBadgeInfo(linkedPR: LinkedPRInfo): {
  icon: typeof GitMerge;
  color: string;
  bgColor: string;
} {
  if (linkedPR.state === "MERGED") {
    return {
      icon: GitMerge,
      color: "text-github-merged",
      bgColor: "bg-github-merged/10",
    };
  }
  if (linkedPR.state === "OPEN") {
    return {
      icon: GitPullRequest,
      color: "text-github-open",
      bgColor: "bg-github-open/10",
    };
  }
  return {
    icon: GitPullRequestClosed,
    color: "text-github-closed",
    bgColor: "bg-github-closed/10",
  };
}

function middleTruncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  if (maxLen <= 1) return "…";
  const prefixLen = Math.ceil((maxLen - 1) / 2);
  const suffixLen = Math.floor((maxLen - 1) / 2);
  return `${str.slice(0, prefixLen)}…${str.slice(str.length - suffixLen)}`;
}

export function GitHubListItem({
  item,
  type,
  onCreateWorktree,
  onSwitchToWorktree,
  optionId,
  isActive,
}: GitHubListItemProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);
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

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleOpenExternal = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    void actionService.dispatch("system.openExternal", { url: item.url }, { source: "user" });
  };

  const handleCopyNumber = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    if (!navigator.clipboard) {
      setCopyError(true);
      timeoutRef.current = window.setTimeout(() => setCopyError(false), 2000);
      return;
    }

    try {
      await navigator.clipboard.writeText(`#${item.number}`);
      setCopied(true);
      setCopyError(false);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
      setCopyError(true);
      timeoutRef.current = window.setTimeout(() => setCopyError(false), 2000);
    }
  };

  const getButtonStatus = () => {
    if (copied) return { text: "✓", color: "text-status-success" };
    if (copyError) return { text: `#${item.number}`, color: "text-status-error" };
    return { text: `#${item.number}`, color: "" };
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

  const handleOpenLinkedPR = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!isItemPR && "linkedPR" in item && item.linkedPR) {
      void actionService.dispatch(
        "system.openExternal",
        { url: item.linkedPR.url },
        { source: "user" }
      );
    }
  };

  const status = getButtonStatus();
  const linkedPR = !isItemPR && "linkedPR" in item ? item.linkedPR : undefined;
  const prBadgeInfo = linkedPR ? getPRBadgeInfo(linkedPR) : null;
  const issueLabels: GitHubLabel[] = !isItemPR && "labels" in item ? (item.labels ?? []) : [];
  const visibleLabels = issueLabels.slice(0, 3);
  const overflowLabels = issueLabels.slice(3);

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
                <TooltipContent side="bottom">Open in GitHub</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {prBadgeInfo && linkedPR && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleOpenLinkedPR}
                      className={cn(
                        "shrink-0 text-[11px] px-1.5 py-0.5 rounded font-medium flex items-center gap-1 hover:opacity-80 transition-opacity cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                        prBadgeInfo.color,
                        prBadgeInfo.bgColor
                      )}
                      aria-label={`Open linked pull request #${linkedPR.number} (${linkedPR.state.toLowerCase()})`}
                    >
                      <prBadgeInfo.icon className="w-3 h-3" />
                      <span>#{linkedPR.number}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{`Open PR #${linkedPR.number} (${linkedPR.state.toLowerCase()})`}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {isItemPR && item.isDraft && (
              <span className="shrink-0 text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                Draft
              </span>
            )}
            {hasWorktree && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        "shrink-0 text-[11px] px-1.5 py-0.5 rounded font-medium flex items-center gap-1",
                        isActiveWorktree
                          ? "bg-canopy-accent/10 text-canopy-accent"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      <GitBranch className="w-3 h-3" />
                      Worktree
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isActiveWorktree ? "Active worktree" : "Has worktree"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <div
            className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCopyNumber}
                    className={cn(
                      "hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                      status.color
                    )}
                    aria-label={
                      copied
                        ? `Number ${item.number} copied to clipboard`
                        : copyError
                          ? `Failed to copy number ${item.number}`
                          : `Copy ${type} number ${item.number}`
                    }
                  >
                    {status.text}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {copied ? "Copied!" : copyError ? "Failed to copy" : "Click to copy number"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <span>&middot;</span>
            <span>{item.author.login}</span>
            <span>&middot;</span>
            <span>{formatTimeAgo(item.updatedAt)}</span>
            {isItemPR && item.headRefName && (
              <>
                <span>&middot;</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="font-mono truncate max-w-[160px]">
                        {middleTruncate(item.headRefName, 20)}
                      </span>
                    </TooltipTrigger>
                    {item.headRefName.length > 20 && (
                      <TooltipContent side="bottom">{item.headRefName}</TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
              </>
            )}
            {!isItemPR && item.commentCount > 0 && (
              <>
                <span>&middot;</span>
                <span className="flex items-center gap-0.5 shrink-0">
                  <MessageCircle className="w-3 h-3" />
                  {item.commentCount}
                </span>
              </>
            )}
            {hasWorktree && !isActiveWorktree && onSwitchToWorktree && (
              <>
                <span>&middot;</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleSwitchToWorktree}
                        className="transition-colors flex items-center gap-1 hover:text-canopy-accent"
                      >
                        <GitBranch className="w-3 h-3" />
                        <span>Switch to Worktree</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Switch to existing worktree</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </>
            )}
            {!hasWorktree && onCreateWorktree && item.state === "OPEN" && (
              <>
                <span>&middot;</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleCreateWorktree}
                        disabled={isItemPR && (item as GitHubPR).isFork === true}
                        className={cn(
                          "transition-colors flex items-center gap-1",
                          isItemPR && (item as GitHubPR).isFork === true
                            ? "opacity-40 cursor-not-allowed"
                            : "hover:text-canopy-accent"
                        )}
                      >
                        <GitBranch className="w-3 h-3" />
                        <span>Create Worktree</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {isItemPR && (item as GitHubPR).isFork === true
                        ? "Not available for fork PRs — the branch is on a different remote"
                        : type === "issue"
                          ? "Create Worktree from Issue"
                          : "Create Worktree from PR"}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </>
            )}
          </div>
          {issueLabels.length > 0 && (
            <div className="flex items-center gap-1 mt-1 flex-wrap">
              {visibleLabels.map((label) => (
                <span
                  key={label.name}
                  style={getLabelStyles(label.color)}
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium max-w-[120px] truncate shrink-0"
                >
                  {label.name}
                </span>
              ))}
              {overflowLabels.length > 0 && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="text-[10px] text-muted-foreground cursor-default shrink-0"
                        tabIndex={0}
                        role="note"
                      >
                        +{overflowLabels.length}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {overflowLabels.map((l) => l.name).join(", ")}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {type === "issue" && "assignees" in item && item.assignees.length > 0 && (
            <div className="flex -space-x-1.5">
              {item.assignees.slice(0, 3).map((assignee) => (
                <Avatar
                  key={assignee.login}
                  src={assignee.avatarUrl}
                  alt={assignee.login}
                  title={assignee.login}
                  className="w-5 h-5 border-2 border-canopy-sidebar"
                />
              ))}
              {item.assignees.length > 3 && (
                <span className="w-5 h-5 rounded-full border-2 border-canopy-sidebar bg-muted flex items-center justify-center text-[9px] font-medium text-muted-foreground">
                  +{item.assignees.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
