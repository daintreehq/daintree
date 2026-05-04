import { useCallback, useMemo } from "react";
import type { AgentState, TerminalRecipe, WorktreeState } from "@/types";
import { cn } from "@/lib/utils";
import { STATE_LABELS, STATE_PRIORITY } from "../terminalStateConfig";
import { BranchLabel } from "../BranchLabel";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { Sprout, Pin } from "lucide-react";
import type { AggregateCounts } from "./MainWorktreeSummaryRows";
import { IssueBadge } from "./IssueBadge";
import { EnvironmentPopover } from "./EnvironmentPopover";
import { CollapsedSessionIndicators } from "./CollapsedSessionIndicators";
import { WorktreeActionsToolbar } from "./WorktreeActionsToolbar";
import { MainWorktreeSecondaryRow } from "./MainWorktreeSecondaryRow";
import { NonMainSecondaryRow } from "./NonMainSecondaryRow";

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
  onCleanupWorktree?: () => void;
  badges: {
    onOpenIssue?: () => void;
    onOpenPR?: () => void;
    onOpenPlan?: () => void;
  };

  menu: {
    launchAgents: import("../WorktreeMenuItems").WorktreeLaunchAgentItem[];
    recipes: TerminalRecipe[];
    runningRecipeId: string | null;
    counts: {
      grid: number;
      dock: number;
      active: number;
      completed: number;
      all: number;
      waiting: number;
      working: number;
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
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    onDockAll: () => void;
    onMaximizeAll: () => void;
    onResetRenderers: () => void;
    onSelectAllAgents: () => void;
    onSelectWaitingAgents: () => void;
    onSelectWorkingAgents: () => void;
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
  onCleanupWorktree,
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
  const underlineOnHover = variant !== "sidebar" || isActive;
  const hasUpstreamDelta =
    (worktree.aheadCount !== undefined && worktree.aheadCount > 0) ||
    (worktree.behindCount !== undefined && worktree.behindCount > 0);
  const hasAuthFailedSignIn = Boolean(worktree.fetchAuthFailed && worktree.isGitHubRemote);
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
            isLifecycleRunning) && (
            <EnvironmentPopover
              worktreeMode={worktree.worktreeMode}
              environmentIcon={environmentIcon}
              isLifecycleRunning={isLifecycleRunning}
              resourceStatusLabel={resourceStatusLabel}
              resourceStatusColor={resourceStatusColor}
              resourceLastOutput={resourceLastOutput}
              resourceEndpoint={resourceEndpoint}
              resourceLastCheckedAt={resourceLastCheckedAt}
              onCheckResourceStatus={onCheckResourceStatus}
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
              underlineOnHover={underlineOnHover}
            />
          ) : isMainStandardLayout ? (
            <TruncatedTooltip content={worktree.name}>
              <span
                className={cn(
                  "truncate text-[13px] font-medium transition-colors duration-150",
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
            </TruncatedTooltip>
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
          <CollapsedSessionIndicators
            visibleStates={visibleStates}
            sessionAriaLabel={sessionAriaLabel}
          />
        )}

        <WorktreeActionsToolbar
          isCollapsed={isCollapsed ?? false}
          isActive={isActive}
          onCleanupWorktree={onCleanupWorktree}
          canCollapse={canCollapse ?? false}
          onToggleCollapse={onToggleCollapse}
          contentId={contentId}
          menu={{
            ...menu,
            recipes: recipeOptions,
          }}
          worktree={worktree}
          isPinned={isPinned}
          handleLaunchAgent={handleLaunchAgent}
        />
      </div>

      {!isCollapsed && isMainStandardLayout && (
        <MainWorktreeSecondaryRow
          branchLabel={branchLabel}
          isActive={isActive}
          isMuted={isMuted}
          hasUpstreamDelta={hasUpstreamDelta}
          hasAuthFailedSignIn={hasAuthFailedSignIn}
          aheadCount={worktree.aheadCount}
          behindCount={worktree.behindCount}
          isFetchInFlight={Boolean(worktree.isFetchInFlight)}
          lastFetchedAt={worktree.lastFetchedAt}
          fetchAuthFailed={Boolean(worktree.fetchAuthFailed)}
          fetchNetworkFailed={Boolean(worktree.fetchNetworkFailed)}
          isGitHubRemote={Boolean(worktree.isGitHubRemote)}
          aggregateCounts={aggregateCounts}
        />
      )}

      {!isCollapsed &&
        !isMainStandardLayout &&
        (hasIssueTitle ||
          (worktree.issueNumber && !hasIssueTitle) ||
          (worktree.prNumber && worktree.prState !== "closed") ||
          hasUpstreamDelta ||
          hasAuthFailedSignIn ||
          hasPlanFile) && (
          <NonMainSecondaryRow
            worktree={worktree}
            branchLabel={branchLabel}
            isActive={isActive}
            isMuted={isMuted}
            underlineOnHover={underlineOnHover}
            hasUpstreamDelta={hasUpstreamDelta}
            hasAuthFailedSignIn={hasAuthFailedSignIn}
            hasIssueTitle={hasIssueTitle}
            hasPlanFile={hasPlanFile}
            badges={badges}
          />
        )}
    </div>
  );
}
