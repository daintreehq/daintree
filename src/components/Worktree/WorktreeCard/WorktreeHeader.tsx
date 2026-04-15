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
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import {
  ChevronRight,
  CircleDot,
  CornerDownRight,
  FileText,
  GitBranch,
  GitPullRequest,
  Cloud,
  MoreHorizontal,
  RefreshCw,
  Sprout,
  Pin,
  Server,
  Container,
  Cpu,
  Globe,
  Rocket,
  Database,
  Terminal as TerminalIcon,
  Box,
  Layers,
} from "lucide-react";
import type { AggregateCounts } from "./MainWorktreeSummaryRows";
import { useIssueTooltip, usePRTooltip } from "@/hooks/useGitHubTooltip";
import { IssueTooltipContent, PRTooltipContent, TooltipLoading } from "./GitHubTooltipContent";

const ENVIRONMENT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Server,
  Cloud,
  Container,
  Cpu,
  Globe,
  Rocket,
  Database,
  Terminal: TerminalIcon,
  Box,
  Layers,
};

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
  underlineOnHover?: boolean;
}

const IssueBadge = memo(function IssueBadge({
  issueNumber,
  issueTitle,
  worktreePath,
  onOpen,
  isHeadline,
  isActive,
  underlineOnHover,
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
            if (isActive) onOpen?.();
          }}
          className={cn(
            "flex items-center gap-1.5 text-left cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent min-w-0",
            isHeadline ? "text-[13px]" : "text-xs"
          )}
          aria-disabled={!isActive || undefined}
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
              underlineOnHover && "hover:underline",
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
  isActive?: boolean;
  underlineOnHover?: boolean;
}

const PRBadge = memo(function PRBadge({
  prNumber,
  prState,
  isSubordinate,
  worktreePath,
  onOpen,
  isActive,
  underlineOnHover,
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
            if (isActive) onOpen?.();
          }}
          className="flex items-center gap-1 text-xs text-left cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent min-w-0"
          aria-disabled={!isActive || undefined}
          aria-label={`Open ${prStateLabel} pull request #${prNumber} on GitHub`}
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
  variant?: "sidebar" | "grid";
  isMuted?: boolean;
  isMainWorktree: boolean;
  isMainOnStandardBranch?: boolean;
  isPinned: boolean;
  isCollapsed?: boolean;
  canCollapse?: boolean;
  onToggleCollapse?: (e: React.MouseEvent) => void;
  contentId?: string;
  branchLabel: string;
  sessionStates?: Record<AgentState, number>;
  sessionTotal?: number;
  aggregateCounts?: AggregateCounts;
  environmentIcon?: string;
  isLifecycleRunning?: boolean;
  resourceStatusLabel?: string;
  resourceStatusColor?: "green" | "yellow" | "red" | "neutral";
  resourceLastOutput?: string;
  resourceEndpoint?: string;
  resourceLastCheckedAt?: number;
  onCheckResourceStatus?: () => void;
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
      all: number;
    };
    onCopyContextFull: () => void;
    onCopyContextModified: () => void;
    onCopyPath: () => void;
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
    onCloseAll: () => void;
    onEndAll: () => void;
    onAttachIssue?: () => void;
    onViewPlan?: () => void;
    onOpenReviewHub?: () => void;
    onCompareDiff?: () => void;
    onOpenPanelPalette?: () => void;
    onDeleteWorktree?: () => void;
    onRevertAgentChanges?: () => void;
    hasSnapshot?: boolean;
    hasResourceConfig?: boolean;
    worktreeMode?: string;
    resourceEnvironmentKeys?: string[];
    onSwitchEnvironment?: (envKey: string) => void;
    resourceStatus?: string;
    onResourceProvision?: () => void;
    onResourceResume?: () => void;
    onResourcePause?: () => void;
    onResourceConnect?: () => void;
    onResourceStatus?: () => void;
    onResourceTeardown?: () => void;
  };
}

export function WorktreeHeader({
  worktree,
  isActive,
  variant = "sidebar",
  isMuted,
  isMainWorktree,
  isMainOnStandardBranch,
  isPinned,
  isCollapsed,
  canCollapse,
  onToggleCollapse,
  contentId,
  branchLabel,
  sessionStates,
  sessionTotal,
  aggregateCounts,
  environmentIcon,
  isLifecycleRunning,
  resourceStatusLabel,
  resourceStatusColor,
  resourceLastOutput,
  resourceEndpoint,
  resourceLastCheckedAt,
  onCheckResourceStatus,
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
  // In sidebar variant, badges only become actionable when the card is selected,
  // so the hover underline is misleading on unselected cards. Grid variant has no
  // such two-step ambiguity, so preserve its always-on hover affordance.
  const underlineOnHover = variant !== "sidebar" || isActive;
  const hasUpstreamDelta =
    (worktree.aheadCount !== undefined && worktree.aheadCount > 0) ||
    (worktree.behindCount !== undefined && worktree.behindCount > 0);
  const isMainStandardLayout = !!(isMainOnStandardBranch && !hasIssueTitle);

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
              className="w-3.5 h-3.5 text-daintree-text/60 shrink-0 pointer-events-none"
              aria-hidden="true"
            />
          )}
          {isPinned && !isMainWorktree && (
            <Pin
              className="w-3 h-3 text-daintree-text/40 shrink-0 pointer-events-none"
              aria-label="Pinned"
            />
          )}
          {((worktree.worktreeMode && worktree.worktreeMode !== "local") ||
            resourceStatusLabel ||
            isLifecycleRunning) &&
            (() => {
              const EnvironmentIcon =
                (environmentIcon && ENVIRONMENT_ICONS[environmentIcon]) || Cloud;
              const iconClass = cn(
                "w-3 h-3 shrink-0",
                isLifecycleRunning
                  ? "animate-pulse text-daintree-accent"
                  : resourceStatusColor === "green"
                    ? "text-terminal-bright-green"
                    : resourceStatusColor === "yellow"
                      ? "text-status-warning"
                      : resourceStatusColor === "red"
                        ? "text-status-error"
                        : resourceStatusColor === "neutral" || resourceStatusLabel
                          ? "text-daintree-accent/70"
                          : "text-daintree-text/30"
              );
              const hasDetails =
                resourceStatusLabel ||
                resourceLastOutput ||
                resourceEndpoint ||
                resourceLastCheckedAt;
              if (!hasDetails && !onCheckResourceStatus) {
                return (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <EnvironmentIcon
                        className={cn(iconClass, "pointer-events-none")}
                        aria-label={`${worktree.worktreeMode} environment`}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="top">{worktree.worktreeMode}</TooltipContent>
                  </Tooltip>
                );
              }
              return (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-daintree-accent"
                      aria-label={`${worktree.worktreeMode} environment status`}
                    >
                      <EnvironmentIcon className={iconClass} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent side="top" align="start" className="w-72 p-3 text-xs">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="font-semibold text-text-primary">
                        {worktree.worktreeMode}
                      </span>
                      {resourceStatusLabel && (
                        <span
                          className={cn(
                            "font-medium",
                            resourceStatusColor === "green" && "text-status-success",
                            resourceStatusColor === "yellow" && "text-status-warning",
                            resourceStatusColor === "red" && "text-status-error",
                            (!resourceStatusColor || resourceStatusColor === "neutral") &&
                              "text-text-muted"
                          )}
                        >
                          {resourceStatusLabel}
                        </span>
                      )}
                    </div>
                    {resourceEndpoint && (
                      <div className="mb-2 font-mono text-[11px] text-text-secondary break-all">
                        {resourceEndpoint}
                      </div>
                    )}
                    {resourceLastOutput && (
                      <pre className="mb-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-surface-panel-elevated p-2 font-mono text-[11px] text-text-secondary">
                        {resourceLastOutput.trim()}
                      </pre>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      {resourceLastCheckedAt ? (
                        <span className="text-text-muted">
                          checked{" "}
                          {new Date(resourceLastCheckedAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                      ) : (
                        <span />
                      )}
                      {onCheckResourceStatus && (
                        <button
                          onClick={onCheckResourceStatus}
                          className="flex items-center gap-1 text-text-muted hover:text-text-primary transition-colors"
                        >
                          <RefreshCw className="w-3 h-3" />
                          Check Status
                        </button>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              );
            })()}
          {hasIssueTitle ? (
            <IssueBadge
              issueNumber={worktree.issueNumber!}
              issueTitle={worktree.issueTitle}
              worktreePath={worktree.path}
              onOpen={badges.onOpenIssue}
              isHeadline
              isActive={isActive}
              underlineOnHover={underlineOnHover}
            />
          ) : isMainStandardLayout ? (
            <span
              className={cn(
                "truncate text-[13px] font-medium transition-colors duration-200",
                isActive
                  ? "text-text-primary/90"
                  : isMuted
                    ? "text-text-muted"
                    : "text-text-secondary"
              )}
              data-testid="primary-worktree-project-name"
            >
              {worktree.name}
            </span>
          ) : (
            <BranchLabel
              label={branchLabel}
              isActive={isActive}
              isMuted={isMuted}
              isMainWorktree={isMainOnStandardBranch ?? isMainWorktree}
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

        <div
          data-testid="worktree-actions-wrapper"
          className={cn(
            "flex items-center gap-0.5 shrink-0 transition-opacity duration-150",
            isCollapsed
              ? "opacity-100"
              : isActive
                ? "opacity-100"
                : "opacity-0 pointer-events-none group-hover/card:opacity-100 group-hover/card:pointer-events-auto group-focus-within/card:opacity-100 group-focus-within/card:pointer-events-auto"
          )}
        >
          {canCollapse && (
            <button
              onClick={onToggleCollapse}
              className="sidebar-action-button p-1.5 text-daintree-text/60 hover:text-text-primary rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
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
                    className="sidebar-action-button p-1.5 text-daintree-text/60 hover:text-text-primary rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
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
              onContextMenu={(e) => e.stopPropagation()}
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
                onCopyPath={menu.onCopyPath}
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
                onCloseAll={menu.onCloseAll}
                onEndAll={menu.onEndAll}
                onOpenPanelPalette={menu.onOpenPanelPalette}
                onDeleteWorktree={menu.onDeleteWorktree}
                onRevertAgentChanges={menu.onRevertAgentChanges}
                hasSnapshot={menu.hasSnapshot}
                hasResourceConfig={menu.hasResourceConfig}
                worktreeMode={menu.worktreeMode}
                resourceEnvironmentKeys={menu.resourceEnvironmentKeys}
                onSwitchEnvironment={menu.onSwitchEnvironment}
                resourceStatus={menu.resourceStatus}
                onResourceProvision={menu.onResourceProvision}
                onResourceResume={menu.onResourceResume}
                onResourcePause={menu.onResourcePause}
                onResourceConnect={menu.onResourceConnect}
                onResourceStatus={menu.onResourceStatus}
                onResourceTeardown={menu.onResourceTeardown}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Secondary row: branch + inline stats for main worktree, or badges for secondary worktrees */}
      {!isCollapsed && isMainStandardLayout && (
        <div className="flex items-center gap-2 mt-1" data-testid="main-worktree-meta-row">
          <BranchLabel
            label={branchLabel}
            isActive={isActive}
            isMuted={isMuted}
            isMainWorktree={false}
          />
          {hasUpstreamDelta && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="flex items-center gap-1 text-[10px] font-mono tabular-nums"
                  data-testid="upstream-sync-indicator"
                >
                  {worktree.aheadCount !== undefined && worktree.aheadCount > 0 && (
                    <span className="text-status-success">↑{worktree.aheadCount}</span>
                  )}
                  {worktree.behindCount !== undefined && worktree.behindCount > 0 && (
                    <span className="text-status-warning">↓{worktree.behindCount}</span>
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">
                {worktree.aheadCount !== undefined && worktree.aheadCount > 0 && (
                  <span>
                    {worktree.aheadCount} commit{worktree.aheadCount !== 1 ? "s" : ""} ahead
                  </span>
                )}
                {worktree.aheadCount !== undefined &&
                  worktree.aheadCount > 0 &&
                  worktree.behindCount !== undefined &&
                  worktree.behindCount > 0 && <span>, </span>}
                {worktree.behindCount !== undefined && worktree.behindCount > 0 && (
                  <span>
                    {worktree.behindCount} commit{worktree.behindCount !== 1 ? "s" : ""} behind
                  </span>
                )}
                <span> upstream</span>
              </TooltipContent>
            </Tooltip>
          )}
          {aggregateCounts && aggregateCounts.worktrees > 0 && (
            <>
              <span className="text-text-muted/40 text-[10px]" aria-hidden="true">
                ·
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="flex items-center gap-1.5 text-[10px] text-daintree-text/50"
                    data-testid="aggregate-worktree-row"
                  >
                    <span className="flex items-center gap-0.5">
                      <GitBranch className="w-2.5 h-2.5" aria-hidden="true" />
                      <span className="font-mono tabular-nums">{aggregateCounts.worktrees}</span>
                    </span>
                    {aggregateCounts.working > 0 && (
                      <span className={cn("flex items-center gap-0.5", STATE_COLORS.working)}>
                        <STATE_ICONS.working
                          className="w-2.5 h-2.5 animate-spin-slow motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                        <span className="font-mono tabular-nums">{aggregateCounts.working}</span>
                      </span>
                    )}
                    {aggregateCounts.waiting > 0 && (
                      <span className={cn("flex items-center gap-0.5", STATE_COLORS.waiting)}>
                        <STATE_ICONS.waiting className="w-2.5 h-2.5" aria-hidden="true" />
                        <span className="font-mono tabular-nums">{aggregateCounts.waiting}</span>
                      </span>
                    )}
                    {aggregateCounts.finished > 0 &&
                      aggregateCounts.working === 0 &&
                      aggregateCounts.waiting === 0 && (
                        <span className={cn("flex items-center gap-0.5", STATE_COLORS.completed)}>
                          <STATE_ICONS.completed className="w-2.5 h-2.5" aria-hidden="true" />
                          <span className="font-mono tabular-nums">{aggregateCounts.finished}</span>
                        </span>
                      )}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" className="text-xs">
                  {aggregateCounts.worktrees} worktree
                  {aggregateCounts.worktrees !== 1 ? "s" : ""}
                  {(aggregateCounts.working > 0 ||
                    aggregateCounts.waiting > 0 ||
                    aggregateCounts.finished > 0) &&
                    " — "}
                  {[
                    aggregateCounts.working > 0 && `${aggregateCounts.working} working`,
                    aggregateCounts.waiting > 0 && `${aggregateCounts.waiting} waiting`,
                    aggregateCounts.finished > 0 && `${aggregateCounts.finished} done`,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      )}

      {/* Secondary row for non-main-standard layouts: issue badge, PR badge, sync indicator, plan badge */}
      {!isCollapsed &&
        !isMainStandardLayout &&
        (hasIssueTitle ||
          (worktree.issueNumber && !hasIssueTitle) ||
          (worktree.prNumber && worktree.prState !== "closed") ||
          hasUpstreamDelta ||
          hasPlanFile) && (
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
            {hasUpstreamDelta && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="flex items-center gap-1.5 text-[10px] font-mono tabular-nums"
                    data-testid="upstream-sync-indicator"
                  >
                    {worktree.aheadCount !== undefined && worktree.aheadCount > 0 && (
                      <span className="text-status-success">↑{worktree.aheadCount}</span>
                    )}
                    {worktree.behindCount !== undefined && worktree.behindCount > 0 && (
                      <span className="text-status-warning">↓{worktree.behindCount}</span>
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" className="text-xs">
                  {worktree.aheadCount !== undefined && worktree.aheadCount > 0 && (
                    <span>
                      {worktree.aheadCount} commit{worktree.aheadCount !== 1 ? "s" : ""} ahead
                    </span>
                  )}
                  {worktree.aheadCount !== undefined &&
                    worktree.aheadCount > 0 &&
                    worktree.behindCount !== undefined &&
                    worktree.behindCount > 0 && <span>, </span>}
                  {worktree.behindCount !== undefined && worktree.behindCount > 0 && (
                    <span>
                      {worktree.behindCount} commit{worktree.behindCount !== 1 ? "s" : ""} behind
                    </span>
                  )}
                  <span> upstream</span>
                </TooltipContent>
              </Tooltip>
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
                <FileText className="w-3 h-3 shrink-0 text-daintree-accent/70" aria-hidden="true" />
                <span className={cn("font-mono", underlineOnHover && "hover:underline")}>
                  {worktree.planFilePath ?? "Plan"}
                </span>
              </button>
            )}
          </div>
        )}
    </div>
  );
}
