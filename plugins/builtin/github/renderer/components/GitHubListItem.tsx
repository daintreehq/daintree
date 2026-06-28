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
  MessageSquare,
} from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/utils";
import { formatTimeAgo } from "@/utils/timeAgo";
import { actionService } from "@/services/ActionService";
import type { ForgeLabel, Issue, PR } from "@shared/types/forge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getPRCIStatusVisual, getPRCIStatusTooltip } from "../utils/prCIStatus";
import { toGitHubCIStatus } from "../utils/forgeRowAdapters";
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
  item: Issue | PR;
  type: "issue" | "pr";
  onCreateWorktree?: (item: Issue | PR) => void;
  onSwitchToWorktree?: (worktreeId: string) => void;
  optionId?: string;
  isActive?: boolean;
  isSelected?: boolean;
  isSelectionActive?: boolean;
  onToggleSelect?: (e: React.MouseEvent) => void;
}

function getStateIcon(state: string, type: "issue" | "pr") {
  if (type === "issue") {
    return state === "open" ? CircleDot : CheckCircle2;
  }
  if (state === "merged") return GitMerge;
  if (state === "open") return GitPullRequest;
  return GitPullRequestClosed;
}

function getStateColor(state: string, isDraft?: boolean): string {
  if (isDraft) return "text-pr-draft";
  if (state === "open") return "text-pr-open";
  if (state === "merged") return "text-pr-merged";
  return "text-pr-closed";
}

function isPR(item: Issue | PR): item is PR {
  return "isDraft" in item;
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
    setCopied(false);
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

  const issueLabels: ForgeLabel[] = !isItemPR && "labels" in item ? (item.labels ?? []) : [];

  return (
    <div
      id={optionId}
      role="option"
      data-testid={`github-item-${item.number}`}
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
                  ? "bg-daintree-accent border-daintree-accent"
                  : "border-daintree-border hover:border-daintree-accent/60",
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
                "flex-1 min-w-0 text-sm font-medium text-foreground truncate text-left cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded",
                !isSelectionActive && "hover:underline"
              )}
            >
              {item.title}
            </button>

            {isItemPR &&
              item.state === "open" &&
              item.ciStatus &&
              (() => {
                const ciVisual = getPRCIStatusVisual(toGitHubCIStatus(item.ciStatus));
                const ciTooltip = getPRCIStatusTooltip(toGitHubCIStatus(item.ciStatus));
                if (!ciVisual || !ciTooltip) return null;
                return (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="inline-flex items-center justify-center w-3 h-3 shrink-0"
                        aria-label={ciTooltip}
                      >
                        {ciVisual.kind === "icon" ? (
                          <ciVisual.Icon className={cn("w-3 h-3", ciVisual.colorClass)} />
                        ) : (
                          <span className={cn("block w-2 h-2 rounded-full", ciVisual.colorClass)} />
                        )}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{ciTooltip}</TooltipContent>
                  </Tooltip>
                );
              })()}

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCopyNumber();
                  }}
                  className="shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-0.5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded px-1"
                  aria-label={`Copy number ${item.number}`}
                >
                  {copied ? <Check className="w-3 h-3 text-status-success" /> : <span>#</span>}
                  <span>{item.number}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{copied ? "Copied!" : "Copy number"}</TooltipContent>
            </Tooltip>
          </div>

          {/* Metadata row: author, time, branch/labels, worktree, menu */}
          <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground flex-nowrap overflow-hidden">
            <span className="shrink-0">{item.author?.login ?? "unknown"}</span>
            <span className="shrink-0">&middot;</span>
            <span className="whitespace-nowrap shrink-0">{formatTimeAgo(item.updatedAt)}</span>

            {(item.commentCount ?? 0) >= 1 && (
              <>
                <span className="shrink-0">&middot;</span>
                <span className="inline-flex items-center gap-0.5 shrink-0">
                  <MessageSquare className="w-3 h-3" />
                  <span>{item.commentCount}</span>
                </span>
              </>
            )}

            {isItemPR && item.headRef && (
              <>
                <span className="shrink-0">&middot;</span>
                <span className="truncate max-w-[120px]">{item.headRef}</span>
              </>
            )}

            {!isItemPR && issueLabels.length > 0 && (
              <>
                <span className="shrink-0">&middot;</span>
                <span className="inline-flex items-center gap-1 min-w-0 shrink max-w-[180px]">
                  {issueLabels.slice(0, 2).map((label) => (
                    <span key={label.name} className="inline-flex items-center gap-1 min-w-0">
                      {label.color ? (
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: `#${label.color}` }}
                        />
                      ) : null}
                      <span className="truncate min-w-0 max-w-[80px]">{label.name}</span>
                    </span>
                  ))}
                </span>
              </>
            )}

            {!isItemPR && "linkedPR" in item && item.linkedPR && (
              <>
                <span className="shrink-0">&middot;</span>
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
                      className="shrink-0 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded p-0.5"
                      aria-label={`Linked PR #${item.linkedPR.number}`}
                    >
                      <GitPullRequest className="w-3 h-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">PR #{item.linkedPR.number}</TooltipContent>
                </Tooltip>
              </>
            )}

            <span className="flex-1" />

            {!isItemPR && item.assignees.length > 0 && (
              <Avatar
                src={item.assignees[0]!.avatarUrl ?? ""}
                alt={item.assignees[0]!.login}
                title={`Assigned to ${item.assignees[0]!.login}`}
                className="w-4 h-4 shrink-0"
              />
            )}

            {hasWorktree ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  {isActiveWorktree ? (
                    <span className="shrink-0 text-status-info">
                      <FolderGit2 className="w-3.5 h-3.5" />
                    </span>
                  ) : onSwitchToWorktree && matchedWorktree ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSwitchToWorktree(matchedWorktree.id);
                      }}
                      className="shrink-0 text-pr-open hover:text-pr-open/80 transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded p-0.5"
                      aria-label="Switch to worktree"
                    >
                      <FolderGit2 className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <span className="shrink-0 text-pr-open">
                      <FolderGit2 className="w-3.5 h-3.5" />
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
            ) : item.state === "open" && onCreateWorktree ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCreateWorktree(item);
                    }}
                    className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded p-0.5"
                    aria-label="Create worktree"
                  >
                    <FolderGit2 className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Create worktree</TooltipContent>
              </Tooltip>
            ) : null}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "shrink-0 p-0.5 rounded hover:bg-muted transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
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
                      <FolderGit2 className="h-3.5 w-3.5 mr-2" />
                      Switch to Worktree
                    </DropdownMenuItem>
                  </>
                )}

                {!hasWorktree && onCreateWorktree && item.state === "open" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => onCreateWorktree(item)}>
                      <FolderGit2 className="h-3.5 w-3.5 mr-2" />
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
