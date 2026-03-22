import { useCallback, useMemo, useState, memo } from "react";
import type { AgentState, TerminalRecipe, WorktreeState } from "@/types";
import { cn } from "@/lib/utils";
import { STATE_ICONS, STATE_COLORS, STATE_LABELS, STATE_PRIORITY } from "../terminalStateConfig";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import {
  AlertCircle,
  ChevronRight,
  CircleDot,
  CornerDownRight,
  FileText,
  GitPullRequest,
  MoreHorizontal,
  Sprout,
  Pin,
} from "lucide-react";
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
    <Tooltip open={isOpen} onOpenChange={handleOpenChange} delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
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
              "truncate flex-1 min-w-0 hover:underline",
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
        {loading ? (
          <TooltipLoading type="issue" />
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
    <Tooltip open={isOpen} onOpenChange={handleOpenChange} delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            onOpen?.();
          }}
          className="flex items-center gap-1 text-xs text-left cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent min-w-0"
          aria-label={`Open ${prStateLabel} pull request #${prNumber} on GitHub`}
        >
          {isSubordinate && (
            <CornerDownRight className="w-3 h-3 text-text-muted shrink-0" aria-hidden="true" />
          )}
          <GitPullRequest className={cn("w-3 h-3 shrink-0", prStateColor)} aria-hidden="true" />
          <span className={cn("font-mono hover:underline", prStateColor)}>#{prNumber}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="p-3">
        {loading ? (
          <TooltipLoading type="pr" />
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
  worktreeErrorCount: number;
  sessionStates?: Record<AgentState, number>;
  sessionTotal?: number;
  badges: {
    onOpenIssue?: () => void;
    onOpenPR?: () => void;
    onOpenPlan?: () => void;
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
    onOpenIssuePortal?: () => void;
    onOpenIssueExternal?: () => void;
    onOpenPRPortal?: () => void;
    onOpenPRExternal?: () => void;
    onRunRecipe: (recipeId: string) => void;
    onSaveLayout?: () => void;
    onTogglePin?: () => void;
    onToggleCollapse?: () => void;
    isCollapsed?: boolean;
    onLaunchAgent?: (agentId: string) => void;
    onDockAll: () => void;
    onMaximizeAll: () => void;
    onRestartAll: () => void;
    onResetRenderers: () => void;
    onCloseCompleted: () => void;
    onCloseFailed: () => void;
    onCloseAll: () => void;
    onEndAll: () => void;
    onAttachIssue?: () => void;
    onViewPlan?: () => void;
    onOpenReviewHub?: () => void;
    onCompareDiff?: () => void;
    onDeleteWorktree?: () => void;
  };
}

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
  worktreeErrorCount,
  sessionStates,
  sessionTotal,
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
  const hasPlanFile = Boolean(worktree.hasPlanFile);

  const { visibleStates, sessionAriaLabel } = useMemo(() => {
    if (!sessionStates || !sessionTotal || sessionTotal === 0) {
      return { visibleStates: [] as { state: AgentState; count: number }[], sessionAriaLabel: "" };
    }
    const visible = STATE_PRIORITY.filter((s) => s !== "idle" && sessionStates[s] > 0).map((s) => ({
      state: s,
      count: sessionStates[s],
    }));
    const parts = visible.map((v) => `${v.count} ${STATE_LABELS[v.state]}`);
    const label = `${sessionTotal} session${sessionTotal !== 1 ? "s" : ""}: ${parts.join(", ")}`;
    return { visibleStates: visible, sessionAriaLabel: label };
  }, [sessionStates, sessionTotal]);

  return (
    <div>
      <div className="flex items-center gap-2 min-h-[22px]">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isMainWorktree && (
            <Sprout
              className="w-3.5 h-3.5 text-canopy-text/60 shrink-0 pointer-events-none"
              aria-hidden="true"
            />
          )}
          {isPinned && !isMainWorktree && (
            <Pin
              className="w-3 h-3 text-canopy-text/40 shrink-0 pointer-events-none"
              aria-label="Pinned"
            />
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
          {worktree.isDetached && (
            <span className="text-status-warning text-xs font-medium shrink-0 pointer-events-none">
              (detached)
            </span>
          )}
        </div>

        {isCollapsed && visibleStates.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="flex items-center gap-1.5 shrink-0"
                role="img"
                aria-label={sessionAriaLabel}
                data-testid="collapsed-session-indicators"
              >
                {visibleStates.map(({ state, count }) => {
                  const Icon = STATE_ICONS[state];
                  return (
                    <span
                      key={state}
                      aria-hidden="true"
                      className={cn("flex items-center gap-0.5 text-[10px]", STATE_COLORS[state])}
                    >
                      <Icon
                        className={cn(
                          "w-2.5 h-2.5",
                          state === "working" && "animate-spin-slow motion-reduce:animate-none"
                        )}
                      />
                      <span className="font-mono tabular-nums">{count}</span>
                    </span>
                  );
                })}
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {visibleStates.map((v) => `${v.count} ${STATE_LABELS[v.state]}`).join(", ")}
            </TooltipContent>
          </Tooltip>
        )}

        {worktreeErrorCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-0.5 text-status-error text-xs font-mono tabular-nums shrink-0">
                <AlertCircle className="w-3 h-3" />
                <span>{worktreeErrorCount}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {worktreeErrorCount} error{worktreeErrorCount !== 1 ? "s" : ""}
            </TooltipContent>
          </Tooltip>
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
              className="p-1.5 text-canopy-text/60 hover:text-text-primary hover:bg-[var(--recipe-sidebar-action-hover-bg)] rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
              aria-expanded={!isCollapsed}
              aria-controls={isCollapsed ? undefined : contentId}
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
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    onClick={(e) => e.stopPropagation()}
                    className="p-1.5 text-canopy-text/60 hover:text-text-primary hover:bg-[var(--recipe-sidebar-action-hover-bg)] rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                    aria-label="More actions"
                    data-testid="worktree-actions-menu"
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">More actions</TooltipContent>
            </Tooltip>
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
                onOpenIssuePortal={menu.onOpenIssuePortal}
                onOpenIssueExternal={menu.onOpenIssueExternal}
                onOpenPRPortal={menu.onOpenPRPortal}
                onOpenPRExternal={menu.onOpenPRExternal}
                onAttachIssue={menu.onAttachIssue}
                onViewPlan={menu.onViewPlan}
                onOpenReviewHub={menu.onOpenReviewHub}
                onCompareDiff={menu.onCompareDiff}
                onRunRecipe={menu.onRunRecipe}
                onSaveLayout={menu.onSaveLayout}
                onTogglePin={menu.onTogglePin}
                onToggleCollapse={menu.onToggleCollapse}
                isCollapsed={menu.isCollapsed}
                onDockAll={menu.onDockAll}
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

      {/* Secondary row: branch label when issue title is headline, issue badge fallback, PR badge, and/or plan badge */}
      {!isCollapsed &&
        (hasIssueTitle ||
          (worktree.issueNumber && !hasIssueTitle) ||
          (worktree.prNumber && worktree.prState !== "closed") ||
          hasPlanFile) && (
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
            {hasPlanFile && badges.onOpenPlan && (
              <button
                type="button"
                onClick={() => {
                  badges.onOpenPlan?.();
                }}
                className="flex items-center gap-1 text-xs text-left cursor-pointer transition-colors text-canopy-text/70 hover:text-canopy-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                aria-label="View agent plan file"
              >
                <FileText className="w-3 h-3 shrink-0 text-canopy-accent/70" aria-hidden="true" />
                <span className="font-mono hover:underline">{worktree.planFilePath ?? "Plan"}</span>
              </button>
            )}
          </div>
        )}
    </div>
  );
}
