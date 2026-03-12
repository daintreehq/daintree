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
}

const IssueBadge = memo(function IssueBadge({
  issueNumber,
  issueTitle,
  worktreePath,
  onOpen,
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
            className="flex items-center gap-1.5 text-xs text-left cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent min-w-0"
            aria-label={
              issueTitle
                ? `Open issue #${issueNumber}: ${issueTitle}`
                : `Open issue #${issueNumber} on GitHub`
            }
          >
            <CircleDot className="w-3 h-3 text-github-open shrink-0" aria-hidden="true" />
            <span className="truncate text-canopy-text/90 flex-1 min-w-0">
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
  worktreePath: string;
  isSubordinate: boolean;
  onOpen?: () => void;
}

const PRBadge = memo(function PRBadge({
  prNumber,
  prState,
  worktreePath,
  isSubordinate,
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
            className="flex items-center gap-1 text-xs text-left cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
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
  isMainWorktree: boolean;
  isPinned: boolean;
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
  isMainWorktree,
  isPinned,
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

  return (
    <div className="space-y-1">
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
          <BranchLabel label={branchLabel} isActive={isActive} isMainWorktree={isMainWorktree} />
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
          className={cn(
            "shrink-0 transition-opacity duration-150",
            isActive
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          )}
        >
          <DropdownMenu>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      onClick={(e) => e.stopPropagation()}
                      className="p-1 text-canopy-text/60 hover:text-white hover:bg-white/5 rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
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

      {(worktree.issueNumber || (worktree.prNumber && worktree.prState !== "closed")) && (
        <div className="flex flex-col gap-0.5">
          {worktree.issueNumber && (
            <IssueBadge
              issueNumber={worktree.issueNumber}
              issueTitle={worktree.issueTitle}
              worktreePath={worktree.path}
              onOpen={badges.onOpenIssue}
            />
          )}
          {worktree.prNumber && worktree.prState !== "closed" && (
            <PRBadge
              prNumber={worktree.prNumber}
              prState={worktree.prState}
              worktreePath={worktree.path}
              isSubordinate={!!worktree.issueNumber}
              onOpen={badges.onOpenPR}
            />
          )}
        </div>
      )}
    </div>
  );
}
