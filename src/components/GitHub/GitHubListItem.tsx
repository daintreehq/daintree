import { useState, useRef, useEffect } from "react";
import {
  CircleDot,
  CheckCircle2,
  GitPullRequest,
  GitMerge,
  GitPullRequestClosed,
  MoreHorizontal,
  ExternalLink,
  Check,
  X,
  MessageSquare,
} from "lucide-react";
import { WorktreeIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/utils";
import { formatTimeAgo } from "@/utils/timeAgo";
import { actionService } from "@/services/ActionService";
import type { GitHubIssue, GitHubPR, GitHubLabel, GitHubPRCIStatus } from "@shared/types/github";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

interface GitHubListItemProps {
  item: GitHubIssue | GitHubPR;
  type: "issue" | "pr";
  onCreateWorktree?: (item: GitHubIssue | GitHubPR) => void;
  onSwitchToWorktree?: (worktreeId: string) => void;
  optionId?: string;
  isActive?: boolean;
  isSelected?: boolean;
  isSelectionActive?: boolean;
  onToggleSelect?: (e: React.MouseEvent) => void;
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

function getCIStatusInfo(status: GitHubPRCIStatus): {
  icon: typeof Check | null;
  color: string;
  tooltip: string;
} {
  switch (status) {
    case "SUCCESS":
      return { icon: Check, color: "text-status-success", tooltip: "All checks passed" };
    case "PENDING":
    case "EXPECTED":
      return { icon: null, color: "bg-status-warning", tooltip: "Checks pending" };
    case "FAILURE":
    case "ERROR":
      return { icon: X, color: "text-status-error", tooltip: "Checks failing" };
    default:
      return { icon: null, color: "bg-muted-foreground", tooltip: "Check status unknown" };
  }
}

export function GitHubListItem({
  item,
  type,
  onCreateWorktree,
  onSwitchToWorktree,
  optionId,
  isActive,
  isSelected = false,
  isSelectionActive = false,
  onToggleSelect,
}: GitHubListItemProps) {
  const isItemPR = isPR(item);
  const StateIcon = getStateIcon(item.state, type);
  const stateColor = getStateColor(item.state, isItemPR && item.isDraft);

  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const matchedWorktree = useWorktreeStore((s) => {
    for (const wt of s.worktrees.values()) {
      if (type === "issue" ? wt.issueNumber === item.number : wt.prNumber === item.number)
        return wt;
    }
    return undefined;
  });
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const hasWorktree = matchedWorktree !== undefined;
  const isActiveWorktree = hasWorktree && matchedWorktree.id === activeWorktreeId;

  const handleOpenExternal = () => {
    void actionService.dispatch("system.openExternal", { url: item.url }, { source: "user" });
  };

  const handleCopyNumber = async () => {
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    try {
      await navigator.clipboard.writeText(`#${item.number}`);
      setCopied(true);
      copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const issueLabels: GitHubLabel[] = !isItemPR && "labels" in item ? (item.labels ?? []) : [];

  return (
    <div
      id={optionId}
      role="option"
      aria-selected={isSelected}
      className={cn(
        "hover:bg-muted/50 transition-colors group cursor-default select-none",
        isActive && !isSelected && "bg-muted/50",
        isSelected && "bg-muted/80 hover:bg-muted/80"
      )}
      onClick={isSelectionActive && onToggleSelect ? (e) => onToggleSelect(e) : undefined}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        {onToggleSelect ? (
          <span className="group/icon shrink-0 mt-0.5 relative w-4 h-4">
            {/* State icon: visible by default, hidden on hover or when selection active */}
            <span
              className={cn(
                "absolute inset-0",
                stateColor,
                isSelectionActive || isSelected ? "hidden" : "group-hover/icon:hidden"
              )}
            >
              <StateIcon className="h-4 w-4" />
            </span>
            {/* Checkbox: hidden by default, visible on hover or when selection active */}
            <span
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect(e);
              }}
              className={cn(
                "absolute inset-0 rounded border flex items-center justify-center transition-colors cursor-pointer",
                isSelected
                  ? "bg-canopy-accent border-canopy-accent"
                  : "border-canopy-border hover:border-canopy-accent/60",
                isSelectionActive || isSelected ? "flex" : "hidden group-hover/icon:flex"
              )}
            >
              {isSelected && <Check className="w-3 h-3 text-text-inverse" />}
            </span>
          </span>
        ) : (
          <span className={cn("shrink-0 mt-0.5", stateColor)}>
            <StateIcon className="h-4 w-4" />
          </span>
        )}

        <div className="flex-1 min-w-0">
          {/* Title row: title, CI dot, #number copy */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (isSelectionActive && onToggleSelect) {
                  onToggleSelect(e);
                } else {
                  handleOpenExternal();
                }
              }}
              className={cn(
                "flex-1 min-w-0 text-sm font-medium text-foreground truncate text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded",
                !isSelectionActive && "hover:underline"
              )}
            >
              {item.title}
            </button>

            {isItemPR &&
              item.state === "OPEN" &&
              item.ciStatus &&
              (() => {
                const ciInfo = getCIStatusInfo(item.ciStatus);
                return (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="shrink-0" aria-label={ciInfo.tooltip}>
                          {ciInfo.icon ? (
                            <ciInfo.icon className={cn("w-3 h-3", ciInfo.color)} />
                          ) : (
                            <span className={cn("block w-2 h-2 rounded-full", ciInfo.color)} />
                          )}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{ciInfo.tooltip}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                );
              })()}

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleCopyNumber();
                    }}
                    className="shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded px-1"
                    aria-label={`Copy number ${item.number}`}
                  >
                    {copied ? <Check className="w-3 h-3 text-status-success" /> : <span>#</span>}
                    <span>{item.number}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{copied ? "Copied!" : "Copy number"}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          {/* Metadata row: author, time, branch/labels, worktree, menu */}
          <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground flex-nowrap overflow-hidden">
            <span className="shrink-0">{item.author.login}</span>
            <span className="shrink-0">&middot;</span>
            <span className="whitespace-nowrap shrink-0">{formatTimeAgo(item.updatedAt)}</span>

            {isItemPR && (item as GitHubPR).headRefName && (
              <>
                <span className="shrink-0">&middot;</span>
                <span className="truncate max-w-[120px]">{(item as GitHubPR).headRefName}</span>
              </>
            )}

            {!isItemPR && issueLabels.length > 0 && (
              <>
                <span className="shrink-0">&middot;</span>
                <span className="inline-flex items-center gap-1 min-w-0 shrink max-w-[180px]">
                  {issueLabels.slice(0, 2).map((label) => (
                    <span key={label.name} className="inline-flex items-center gap-1 min-w-0">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: `#${label.color}` }}
                      />
                      <span className="truncate min-w-0 max-w-[80px]">{label.name}</span>
                    </span>
                  ))}
                </span>
              </>
            )}

            {(item.commentCount ?? 0) >= 1 && (
              <>
                <span className="shrink-0">&middot;</span>
                <span className="inline-flex items-center gap-0.5 shrink-0">
                  <MessageSquare className="w-3 h-3" />
                  <span>{item.commentCount}</span>
                </span>
              </>
            )}

            {!isItemPR && "linkedPR" in item && item.linkedPR && (
              <>
                <span className="shrink-0">&middot;</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void actionService.dispatch(
                            "system.openExternal",
                            { url: item.linkedPR!.url },
                            { source: "user" }
                          );
                        }}
                        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded p-0.5"
                        aria-label={`Linked PR #${item.linkedPR.number}`}
                      >
                        <GitPullRequest className="w-3 h-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">PR #{item.linkedPR.number}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </>
            )}

            <span className="flex-1" />

            {!isItemPR && item.assignees.length > 0 && (
              <Avatar
                src={item.assignees[0].avatarUrl}
                alt={item.assignees[0].login}
                title={`Assigned to ${item.assignees[0].login}`}
                className="w-4 h-4 shrink-0"
              />
            )}

            {hasWorktree ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    {isActiveWorktree ? (
                      <span className="shrink-0 text-canopy-accent">
                        <WorktreeIcon className="w-3.5 h-3.5" />
                      </span>
                    ) : onSwitchToWorktree && matchedWorktree ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSwitchToWorktree(matchedWorktree.id);
                        }}
                        className="shrink-0 text-github-open hover:text-github-open/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded p-0.5"
                        aria-label="Switch to worktree"
                      >
                        <WorktreeIcon className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <span className="shrink-0 text-github-open">
                        <WorktreeIcon className="w-3.5 h-3.5" />
                      </span>
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isActiveWorktree
                      ? "Active worktree"
                      : onSwitchToWorktree && matchedWorktree
                        ? "Switch to worktree"
                        : "Has worktree"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : item.state === "OPEN" && onCreateWorktree ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCreateWorktree(item);
                      }}
                      className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded p-0.5"
                      aria-label="Create worktree"
                    >
                      <WorktreeIcon className="w-3.5 h-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Create worktree</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "shrink-0 p-0.5 rounded hover:bg-muted transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isActive
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                  )}
                  aria-label="More actions"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end">
                <DropdownMenuItem onSelect={() => handleOpenExternal()}>
                  <ExternalLink className="h-3.5 w-3.5 mr-2" />
                  Open in GitHub
                </DropdownMenuItem>

                {hasWorktree && !isActiveWorktree && onSwitchToWorktree && matchedWorktree && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => onSwitchToWorktree(matchedWorktree.id)}>
                      <WorktreeIcon className="h-3.5 w-3.5 mr-2" />
                      Switch to Worktree
                    </DropdownMenuItem>
                  </>
                )}

                {!hasWorktree && onCreateWorktree && item.state === "OPEN" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => onCreateWorktree(item)}>
                      <WorktreeIcon className="h-3.5 w-3.5 mr-2" />
                      Create Worktree
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  );
}
