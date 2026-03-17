import { useCallback, useMemo, useState, memo } from "react";
import type { TerminalRecipe, WorktreeState } from "@/types";
import { cn } from "@/lib/utils";
import { BranchLabel } from "../BranchLabel";
import {
  WorktreeMenuItems,
  type WorktreeLaunchAgentItem,
  type WorktreeMenuComponents,
} from "../WorktreeMenuItems";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "../../ui/tooltip";
import {
  AlertCircle,
  Check,
  ChevronRight,
  CircleDot,
  CornerDownRight,
  GitPullRequest,
  MoreHorizontal,
  House,
  Pin,
  type LucideIcon,
} from "lucide-react";
import type { WorktreeLifecycleStage } from "./hooks/useWorktreeStatus";
import { useIssueTooltip, usePRTooltip } from "@/hooks/useGitHubTooltip";
import { IssueTooltipContent, PRTooltipContent, TooltipLoading } from "./GitHubTooltipContent";

const DROPDOWN_COMPONENTS: WorktreeMenuComponents = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

interface IssueBadgeProps {
  issueNumber: number;
  issueTitle?: string;
  worktreePath: string;
  onOpen?: () => void;
  isHeadline?: boolean;
  isActive?: boolean;
}

const IssueBadge = memo(function IssueBadge({
  issueNumber,
  issueTitle,
  worktreePath,
  onOpen,
  isHeadline,
  isActive,
}: IssueBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { data, loading, error, fetchTooltip, reset } = useIssueTooltip(worktreePath, issueNumber);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (open) {
        fetchTooltip();
      } else {
        reset();
      }
    },
    [fetchTooltip, reset]
  );

  return (
    <TooltipProvider>
      <Tooltip open={isOpen} onOpenChange={handleOpenChange} delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen?.();
            }}
            className={cn(
              "flex items-center gap-1.5 text-left cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent min-w-0",
              isHeadline ? "text-[13px]" : "text-xs"
            )}
            aria-label={
              issueTitle
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
                isHeadline
                  ? isActive
                    ? "text-text-primary font-medium"
                    : "text-canopy-text/60 font-medium"
                  : "text-canopy-text/90"
              )}
            >
              {issueTitle || <span className="text-github-open font-mono">#{issueNumber}</span>}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" align="start" className="p-3">
          {loading ? (
            <TooltipLoading type="issue" />
          ) : data ? (
            <IssueTooltipContent data={data} />
          ) : error ? (
            <span className="text-xs text-canopy-text/70">Failed to load issue details</span>
          ) : (
            <span className="text-xs text-canopy-text/70">Issue #{issueNumber}</span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

interface PRBadgeProps {
  prNumber: number;
  prState?: "open" | "merged" | "closed";
  isSubordinate: boolean;
  worktreePath: string;
  onOpen?: () => void;
}

const PRBadge = memo(function PRBadge({
  prNumber,
  prState,
  isSubordinate,
  worktreePath,
  onOpen,
}: PRBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { data, loading, error, fetchTooltip, reset } = usePRTooltip(worktreePath, prNumber);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (open) {
        fetchTooltip();
      } else {
        reset();
      }
    },
    [fetchTooltip, reset]
  );

  const prStateColor =
    prState === "merged"
      ? "text-github-merged"
      : prState === "closed"
        ? "text-github-closed"
        : "text-github-open";

  const prStateLabel = prState === "merged" ? "merged" : prState === "closed" ? "closed" : "open";

  return (
    <TooltipProvider>
      <Tooltip open={isOpen} onOpenChange={handleOpenChange} delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen?.();
            }}
            className="flex items-center gap-1 text-xs text-left cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent min-w-0"
            aria-label={`Open ${prStateLabel} pull request #${prNumber} on GitHub`}
          >
            {isSubordinate && (
              <CornerDownRight
                className="w-3 h-3 text-canopy-text/30 shrink-0"
                aria-hidden="true"
              />
            )}
            <GitPullRequest className={cn("w-3 h-3 shrink-0", prStateColor)} aria-hidden="true" />
            <span className={cn("font-mono", prStateColor)}>#{prNumber}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" align="start" className="p-3">
          {loading ? (
            <TooltipLoading type="pr" />
          ) : data ? (
            <PRTooltipContent data={data} />
          ) : error ? (
            <span className="text-xs text-canopy-text/70">Failed to load PR details</span>
          ) : (
            <span className="text-xs text-canopy-text/70">PR #{prNumber}</span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

export interface WorktreeHeaderProps {
  worktree: WorktreeState;
  isActive: boolean;
  isMuted?: boolean;
  isMainWorktree: boolean;
  isPinned: boolean;
  isCollapsed?: boolean;
  canCollapse?: boolean;
  onToggleCollapse?: (e: React.MouseEvent) => void;
  contentId?: string;
  branchLabel: string;
  lifecycleStage: WorktreeLifecycleStage | null;
  worktreeErrorCount: number;

  badges: {
    onOpenIssue?: () => void;
    onOpenPR?: () => void;
  };

  menu: {
    launchAgents: WorktreeLaunchAgentItem[];
    recipes: TerminalRecipe[];
    runningRecipeId: string | null;
    isRestartValidating: boolean;
    counts: {
      grid: number;
      dock: number;
      active: number;
      completed: number;
      failed: number;
      all: number;
    };
    onCopyContextFull: () => void;
    onCopyContextModified: () => void;
    onOpenEditor: () => void;
    onRevealInFinder: () => void;
    onOpenIssueSidecar?: () => void;
    onOpenIssueExternal?: () => void;
    onOpenPRSidecar?: () => void;
    onOpenPRExternal?: () => void;
    onRunRecipe: (recipeId: string) => void;
    onSaveLayout?: () => void;
    onTogglePin?: () => void;
    onToggleCollapse?: () => void;
    isCollapsed?: boolean;
    onLaunchAgent?: (agentId: string) => void;
    onMinimizeAll: () => void;
    onMaximizeAll: () => void;
    onRestartAll: () => void;
    onResetRenderers: () => void;
    onCloseCompleted: () => void;
    onCloseFailed: () => void;
    onCloseAll: () => void;
    onEndAll: () => void;
    onAttachIssue?: () => void;
    onOpenReviewHub?: () => void;
    onCompareDiff?: () => void;
    onDeleteWorktree?: () => void;
  };
}

const LIFECYCLE_CONFIG: Record<
  WorktreeLifecycleStage,
  { icon: LucideIcon; className: string; label: string }
> = {
  "in-review": {
    icon: CircleDot,
    className: "w-2.5 h-2.5 text-canopy-text/65",
    label: "In review",
  },
  merged: {
    icon: Check,
    className: "w-2.5 h-2.5 text-canopy-text/35",
    label: "Merged",
  },
  "ready-for-cleanup": {
    icon: Check,
    className: "w-2.5 h-2.5 text-canopy-text/40",
    label: "Ready for cleanup",
  },
};

const LifecycleStageIndicator = memo(function LifecycleStageIndicator({
  stage,
}: {
  stage: WorktreeLifecycleStage | null;
}) {
  if (!stage) return null;

  const config = LIFECYCLE_CONFIG[stage];
  const Icon = config.icon;

  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <span className="shrink-0 flex items-center justify-center" aria-label={config.label}>
            <Icon className={config.className} aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {config.label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

export function WorktreeHeader({
  worktree,
  isActive,
  isMuted,
  isMainWorktree,
  isPinned,
  isCollapsed,
  canCollapse,
  onToggleCollapse,
  contentId,
  branchLabel,
  lifecycleStage,
  worktreeErrorCount,
  badges,
  menu,
}: WorktreeHeaderProps) {
  const recipeOptions = useMemo(
    () => menu.recipes.map((r) => ({ id: r.id, name: r.name })),
    [menu.recipes]
  );

  const handleLaunchAgent = useCallback(
    (agentId: string) => {
      menu.onLaunchAgent?.(agentId);
    },
    [menu]
  );

  const hasIssueTitle = !!(worktree.issueNumber && worktree.issueTitle);

  return (
    <div>
      <div className="flex items-center gap-2 min-h-[22px]">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isMainWorktree && (
            <House
              className="w-3.5 h-3.5 text-canopy-text/60 shrink-0"
              fill="currentColor"
              stroke="var(--color-canopy-sidebar)"
              strokeWidth={2}
              aria-hidden="true"
            />
          )}
          {isPinned && !isMainWorktree && (
            <Pin className="w-3 h-3 text-canopy-text/40 shrink-0" aria-label="Pinned" />
          )}
          {hasIssueTitle ? (
            <IssueBadge
              issueNumber={worktree.issueNumber!}
              issueTitle={worktree.issueTitle}
              worktreePath={worktree.path}
              onOpen={badges.onOpenIssue}
              isHeadline
              isActive={isActive}
            />
          ) : (
            <BranchLabel
              label={branchLabel}
              isActive={isActive}
              isMuted={isMuted}
              isMainWorktree={isMainWorktree}
            />
          )}
          <LifecycleStageIndicator stage={lifecycleStage} />
          {worktree.isDetached && (
            <span className="text-status-warning text-xs font-medium shrink-0">(detached)</span>
          )}
        </div>

        {worktreeErrorCount > 0 && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-0.5 text-status-error text-xs font-mono shrink-0">
                  <AlertCircle className="w-3 h-3" />
                  <span>{worktreeErrorCount}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {worktreeErrorCount} error{worktreeErrorCount !== 1 ? "s" : ""}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        <div
          data-testid="worktree-actions-wrapper"
          className={cn(
            "flex items-center gap-0.5 shrink-0 transition-opacity duration-150",
            isCollapsed
              ? "opacity-100"
              : isActive
                ? "opacity-100"
                : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
          )}
        >
          {canCollapse && (
            <button
              onClick={onToggleCollapse}
              className="p-1 text-canopy-text/60 hover:text-text-primary hover:bg-overlay-soft rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
              aria-expanded={!isCollapsed}
              aria-controls={contentId}
              aria-label={isCollapsed ? "Expand card" : "Collapse card"}
            >
              <ChevronRight
                className={cn(
                  "w-3.5 h-3.5 transition-transform duration-200",
                  isCollapsed ? "rotate-0" : "rotate-90"
                )}
                aria-hidden="true"
              />
            </button>
          )}
          <DropdownMenu>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      onClick={(e) => e.stopPropagation()}
                      className="p-1 text-canopy-text/60 hover:text-text-primary hover:bg-overlay-soft rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                      aria-label="More actions"
                      data-testid="worktree-actions-menu"
                    >
                      <MoreHorizontal className="w-3.5 h-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top">More actions</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <DropdownMenuContent
              align="end"
              side="bottom"
              sideOffset={4}
              collisionPadding={8}
              onClick={(e) => e.stopPropagation()}
              className="w-64"
            >
              <WorktreeMenuItems
                worktree={worktree}
                components={DROPDOWN_COMPONENTS}
                launchAgents={menu.launchAgents}
                recipes={recipeOptions}
                runningRecipeId={menu.runningRecipeId}
                isRestartValidating={menu.isRestartValidating}
                isPinned={isPinned}
                counts={menu.counts}
                onLaunchAgent={menu.onLaunchAgent ? handleLaunchAgent : undefined}
                onCopyContextFull={menu.onCopyContextFull}
                onCopyContextModified={menu.onCopyContextModified}
                onOpenEditor={menu.onOpenEditor}
                onRevealInFinder={menu.onRevealInFinder}
                onOpenIssueSidecar={menu.onOpenIssueSidecar}
                onOpenIssueExternal={menu.onOpenIssueExternal}
                onOpenPRSidecar={menu.onOpenPRSidecar}
                onOpenPRExternal={menu.onOpenPRExternal}
                onAttachIssue={menu.onAttachIssue}
                onOpenReviewHub={menu.onOpenReviewHub}
                onCompareDiff={menu.onCompareDiff}
                onRunRecipe={menu.onRunRecipe}
                onSaveLayout={menu.onSaveLayout}
                onTogglePin={menu.onTogglePin}
                onToggleCollapse={menu.onToggleCollapse}
                isCollapsed={menu.isCollapsed}
                onMinimizeAll={menu.onMinimizeAll}
                onMaximizeAll={menu.onMaximizeAll}
                onRestartAll={menu.onRestartAll}
                onResetRenderers={menu.onResetRenderers}
                onCloseCompleted={menu.onCloseCompleted}
                onCloseFailed={menu.onCloseFailed}
                onCloseAll={menu.onCloseAll}
                onEndAll={menu.onEndAll}
                onDeleteWorktree={menu.onDeleteWorktree}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Secondary row: branch label when issue title is headline, issue badge fallback, and/or PR badge */}
      {!isCollapsed &&
        (hasIssueTitle ||
          (worktree.issueNumber && !hasIssueTitle) ||
          (worktree.prNumber && worktree.prState !== "closed")) && (
          <div className="flex flex-col gap-0.5 mt-1.5">
            {worktree.issueNumber && !hasIssueTitle && (
              <IssueBadge
                issueNumber={worktree.issueNumber}
                worktreePath={worktree.path}
                onOpen={badges.onOpenIssue}
              />
            )}
            {worktree.prNumber && worktree.prState !== "closed" && (
              <PRBadge
                prNumber={worktree.prNumber}
                prState={worktree.prState}
                isSubordinate={!!worktree.issueNumber}
                worktreePath={worktree.path}
                onOpen={badges.onOpenPR}
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
          </div>
        )}
    </div>
  );
}
