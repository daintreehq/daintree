import { useState, useRef, useEffect } from "react";
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
import { actionService } from "@/services/ActionService";
import type { GitHubIssue, GitHubPR, LinkedPRInfo } from "@shared/types/github";
import { Avatar } from "@/components/ui/Avatar";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

interface GitHubListItemProps {
  item: GitHubIssue | GitHubPR;
  type: "issue" | "pr";
  onCreateWorktree?: (issue: GitHubIssue) => void;
}

function getStateIcon(state: string, type: "issue" | "pr") {
  if (type === "issue") {
    return state === "OPEN" ? CircleDot : CheckCircle2;
  }
  if (state === "MERGED") return GitMerge;
  if (state === "OPEN") return GitPullRequest;
  return GitPullRequestClosed;
}

function getStateColor(state: string): string {
  if (state === "OPEN") return "text-[var(--color-status-info)]";
  if (state === "MERGED") return "text-[var(--color-status-success)]";
  return "text-muted-foreground";
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

function isPR(item: GitHubIssue | GitHubPR): item is GitHubPR {
  return "isDraft" in item;
}

function getPRBadgeInfo(linkedPR: LinkedPRInfo): {
  icon: typeof GitMerge;
  color: string;
  bgColor: string;
} {
  if (linkedPR.state === "MERGED") {
    return {
      icon: GitMerge,
      color: "text-[var(--color-status-success)]",
      bgColor: "bg-[var(--color-status-success)]/10",
    };
  }
  if (linkedPR.state === "OPEN") {
    return {
      icon: GitPullRequest,
      color: "text-[var(--color-status-info)]",
      bgColor: "bg-[var(--color-status-info)]/10",
    };
  }
  return {
    icon: GitPullRequestClosed,
    color: "text-muted-foreground",
    bgColor: "bg-muted",
  };
}

export function GitHubListItem({ item, type, onCreateWorktree }: GitHubListItemProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);
  const StateIcon = getStateIcon(item.state, type);
  const stateColor = getStateColor(item.state);
  const isItemPR = isPR(item);

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
    if (copied) return { text: "✓", color: "text-[var(--color-status-success)]" };
    if (copyError) return { text: `#${item.number}`, color: "text-[var(--color-status-error)]" };
    return { text: `#${item.number}`, color: "" };
  };

  const handleCreateWorktree = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (type === "issue" && onCreateWorktree) {
      onCreateWorktree(item as GitHubIssue);
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

  return (
    <div className="p-3 hover:bg-muted/50 transition-colors group cursor-default">
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
            {type === "issue" && onCreateWorktree && item.state === "OPEN" && (
              <>
                <span>&middot;</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleCreateWorktree}
                        className="hover:text-canopy-accent transition-colors flex items-center gap-1"
                      >
                        <GitBranch className="w-3 h-3" />
                        <span>Create Worktree</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Create Worktree from Issue</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </>
            )}
          </div>
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
