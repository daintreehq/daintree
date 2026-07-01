import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentState, TerminalRecipe, WorktreeState } from "@/types";
import type { RepoState } from "@shared/types";
import type { GitStateIndicator } from "./hooks/useWorktreeStatus";
import { cn } from "@/lib/utils";
import { STATE_LABELS, STATE_PRIORITY } from "../terminalStateConfig";
import { BranchLabel } from "../BranchLabel";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { Sprout, Pin, BellOff, RefreshCw, Play, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { AggregateCounts } from "./MainWorktreeSummaryRows";
import { IssueBadge } from "./IssueBadge";
import { PRBadge } from "./PRBadge";
import { EnvironmentPopover } from "./EnvironmentPopover";
import { DevServerIndicator } from "./DevServerIndicator";
import { CollapsedSessionIndicators } from "./CollapsedSessionIndicators";
import { CollapsedAlarmPill } from "./CollapsedAlarmPill";
import { isLiveDevServerStatus } from "@/lib/worktreeFilters";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import { WorktreeActionsToolbar } from "./WorktreeActionsToolbar";
import { MainWorktreeSecondaryRow } from "./MainWorktreeSecondaryRow";
import { NonMainSecondaryRow } from "./NonMainSecondaryRow";
import { scheduleFlip } from "@/utils/flipScheduler";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { computeAlarmTier } from "@/lib/worktreeAlarmTier";

export interface WorktreeHeaderProps {
  worktree: WorktreeState;
  isActive: boolean;
  variant?: "sidebar" | "grid";
  isMuted?: boolean;
  isProjectNotificationsMuted?: boolean;
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
  devServerSession?: DevPreviewSessionState;
  lastGitStatusCheckedAt?: number;
  onRevalidateGitStatus?: () => void;
  onCheckResourceStatus?: () => void;
  onCleanupWorktree?: () => void;
  badges: {
    onOpenIssue?: () => void;
    onOpenPR?: () => void;
    onOpenPlan?: () => void;
  };

  gitStateIndicator: GitStateIndicator | null;
  onAbortRepositoryOperation?: () => Promise<void>;
  onContinueRepositoryOperation?: () => Promise<void>;

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
    onOpenIssueExternal?: () => void;
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
    onCloseAll: () => void;
    onTerminateAll: () => void;
    onClearHistory: () => void;
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
    onDeleteSnapshot?: () => void;
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
    onStopDevServer?: (worktreeId: string) => void;
    onRestartDevServer?: (worktreeId: string) => void;
  };
}

function formatGitAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function formatGitAgeLong(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  return `${Math.floor(hours / 24)} day${hours >= 48 ? "s" : ""} ago`;
}

function msUntilAgeBoundary(ageMs: number): number {
  if (ageMs < 30_000) return 30_000 - ageMs;
  if (ageMs < 60_000) return 60_000 - ageMs;
  if (ageMs < 5 * 60_000) return 60_000 - (ageMs % 60_000);
  return 3_600_000;
}

function GitStatusFreshnessPill({
  lastGitStatusCheckedAt,
  onRefresh,
}: {
  lastGitStatusCheckedAt?: number;
  onRefresh?: () => void;
}) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (
      lastGitStatusCheckedAt == null ||
      !Number.isFinite(lastGitStatusCheckedAt) ||
      lastGitStatusCheckedAt === 0
    )
      return;
    const age = Date.now() - lastGitStatusCheckedAt;
    const delay = msUntilAgeBoundary(age);
    return scheduleFlip(delay, () => setTick((n) => n + 1));
  }, [lastGitStatusCheckedAt, tick]);

  if (
    lastGitStatusCheckedAt == null ||
    !Number.isFinite(lastGitStatusCheckedAt) ||
    lastGitStatusCheckedAt === 0
  )
    return null;

  void tick;
  const age = Date.now() - lastGitStatusCheckedAt;
  if (age < 30_000) return null;

  if (age >= 5 * 60_000) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRefresh?.();
        }}
        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors duration-150 shrink-0"
      >
        <RefreshCw className="w-3 h-3" />
        <span>Refresh</span>
      </button>
    );
  }

  const isWarning = age >= 60_000;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "text-xs tabular-nums shrink-0 transition-colors duration-150",
            isWarning ? "text-text-muted" : "text-text-muted/60"
          )}
        >
          {formatGitAge(age)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">Git status checked {formatGitAgeLong(age)}</TooltipContent>
    </Tooltip>
  );
}

// Blocking git operations the card can recover from inline.
type BlockingOpKind = "reverting" | "rebasing" | "merging" | "cherry-picking";

// Derived from worktree.repoState (the raw in-progress operation), NOT from
// gitStateIndicator: the indicator gives "conflicted" priority over the
// operation, so a revert/rebase/merge/cherry-pick that hit conflicts — the
// canonical stuck case — would otherwise never surface the recovery row
// (#10715). The Continue button stays disabled while conflicts remain.
const REPO_STATE_TO_BLOCKING_KIND: Partial<Record<RepoState, BlockingOpKind>> = {
  REVERTING: "reverting",
  REBASING: "rebasing",
  MERGING: "merging",
  CHERRY_PICKING: "cherry-picking",
};

// User-facing operation noun (lowercase, for inline button/dialog copy).
const BLOCKING_OP_LABEL: Record<BlockingOpKind, string> = {
  reverting: "revert",
  rebasing: "rebase",
  merging: "merge",
  "cherry-picking": "cherry-pick",
};

// Abort consequence copy, mirrored from ConflictPanel's ABORT_RESTORE_SUFFIX so
// the dialog states the specific outcome rather than generic irreversibility.
const BLOCKING_OP_ABORT_DESCRIPTION: Record<BlockingOpKind, string> = {
  reverting:
    "Discards the in-progress revert and restores the working tree to the state before it started.",
  rebasing: "Discards the in-progress rebase and returns HEAD to the original branch tip.",
  merging: "Discards the in-progress merge and restores the working tree to its pre-merge state.",
  "cherry-picking":
    "Discards the in-progress cherry-pick and restores the working tree to the state before it started.",
};

/**
 * Inline recovery row for a stuck blocking git operation (revert/rebase/merge/
 * cherry-pick) — surfaced on the card so the user isn't left with a permanent
 * state badge and no way out (#10715). Continue is disabled while conflicts
 * remain unresolved; Abort is a D1 destructive action gated by a ConfirmDialog.
 */
function BlockingOpRow({
  kind,
  hasUnresolvedConflicts,
  onAbort,
  onContinue,
}: {
  kind: BlockingOpKind;
  hasUnresolvedConflicts: boolean;
  onAbort: () => Promise<void>;
  onContinue: () => Promise<void>;
}) {
  const [isAbortOpen, setIsAbortOpen] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);
  const label = BLOCKING_OP_LABEL[kind];

  const handleAbort = useCallback(async () => {
    setIsAborting(true);
    try {
      await onAbort();
      setIsAbortOpen(false);
    } catch {
      // Error surfaced via notify() in the parent; keep the dialog open to retry.
    } finally {
      setIsAborting(false);
    }
  }, [onAbort]);

  const handleContinue = useCallback(async () => {
    setIsContinuing(true);
    try {
      await onContinue();
    } catch {
      // Error surfaced via notify() in the parent.
    } finally {
      setIsContinuing(false);
    }
  }, [onContinue]);

  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <Button
        type="button"
        size="xs"
        variant="outline"
        loading={isContinuing}
        disabled={hasUnresolvedConflicts || isAborting || isAbortOpen}
        title={
          hasUnresolvedConflicts ? "Resolve the remaining conflicts before continuing" : undefined
        }
        onClick={(e) => {
          e.stopPropagation();
          void handleContinue();
        }}
      >
        <Play aria-hidden="true" />
        Continue {label}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost-danger"
        disabled={isContinuing}
        onClick={(e) => {
          e.stopPropagation();
          setIsAbortOpen(true);
        }}
      >
        <Ban aria-hidden="true" />
        Abort {label}
      </Button>

      <ConfirmDialog
        isOpen={isAbortOpen}
        onClose={() => {
          if (!isAborting) setIsAbortOpen(false);
        }}
        title={`Abort ${label}?`}
        description={BLOCKING_OP_ABORT_DESCRIPTION[kind]}
        confirmLabel={`Abort ${label}`}
        cancelLabel="Keep working"
        onConfirm={() => void handleAbort()}
        isConfirmLoading={isAborting}
        variant="destructive"
      />
    </div>
  );
}

export function WorktreeHeader({
  worktree,
  isActive,
  variant = "sidebar",
  isMuted,
  isProjectNotificationsMuted,
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
  devServerSession,
  lastGitStatusCheckedAt,
  onRevalidateGitStatus,
  onCheckResourceStatus,
  onCleanupWorktree,
  badges,
  gitStateIndicator,
  onAbortRepositoryOperation,
  onContinueRepositoryOperation,
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

  // PR-originated worktrees (created from the PR dropdown, #8888) invert the
  // default issue-first headline: the PR title leads, with the linked issue
  // shown underneath. `sourcePrNumber` is the in-memory discriminator seeded at
  // creation time.
  const isPrOriginated = !!worktree.sourcePrNumber;
  const prHeadlineTitle = worktree.linked?.pr?.title ?? worktree.prTitle;
  const displayTitle = isPrOriginated
    ? prHeadlineTitle
    : (worktree.issueTitle ?? worktree.branchDerivedTitle);
  // For PR-originated, the headline always renders (PRBadge handles the brief
  // cold-title gap → "#NNN"); otherwise it needs both an issue number and title.
  const hasDisplayTitle = isPrOriginated
    ? !!worktree.sourcePrNumber
    : !!(worktree.issueNumber && displayTitle);
  const hasPlanFile = Boolean(worktree.hasPlanFile);
  const hasFreshnessPill = !!(lastGitStatusCheckedAt && lastGitStatusCheckedAt > 0);
  const hasDevServerSignal = !!devServerSession && isLiveDevServerStatus(devServerSession.status);
  const underlineOnHover = variant !== "sidebar" || isActive;
  const hasUpstreamDelta =
    (worktree.aheadCount !== undefined && worktree.aheadCount > 0) ||
    (worktree.behindCount !== undefined && worktree.behindCount > 0) ||
    (worktree.baseAheadCount != null &&
      worktree.baseAheadCount > 0 &&
      !worktree.baseMatchesUpstream) ||
    (worktree.baseBehindCount != null &&
      worktree.baseBehindCount > 0 &&
      !worktree.baseMatchesUpstream);
  const hasAuthFailedSignIn = Boolean(
    worktree.fetchAuthFailed &&
    (worktree.matchedForgeProviderId != null || worktree.linked?.providerId != null)
  );
  const isMainStandardLayout = !!(isMainOnStandardBranch && !hasDisplayTitle);

  // Inline recovery for a stuck blocking git operation (revert/rebase/merge/
  // cherry-pick). Mounts whenever an operation is in progress, even when it has
  // conflicts (the badge then reads "conflicted" but the op is still abortable).
  // Continue is gated on there being no unresolved conflicts so a half-resolved
  // operation can't be advanced prematurely.
  const blockingOpKind = worktree.repoState
    ? (REPO_STATE_TO_BLOCKING_KIND[worktree.repoState] ?? null)
    : null;
  const hasUnresolvedConflicts = !!worktree.worktreeChanges?.changes?.some(
    (c) => c.status === "conflicted"
  );
  const showBlockingOpRow = !isCollapsed && blockingOpKind !== null;

  const prState = worktree.linked?.pr?.state;
  const isPrLive = prState !== undefined && prState !== "closed" && prState !== "declined";
  const ciState = isPrLive ? worktree.linked?.pr?.ciStatus?.state : undefined;
  const collapsedAlarm = useMemo(
    () =>
      computeAlarmTier({
        ciState,
        authFailed: hasAuthFailedSignIn,
        behindCount: worktree.behindCount,
      }),
    [ciState, hasAuthFailedSignIn, worktree.behindCount]
  );

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
          {hasDisplayTitle ? (
            isPrOriginated ? (
              <PRBadge
                prNumber={worktree.sourcePrNumber!}
                prTitle={displayTitle}
                prState={worktree.linked?.pr?.state}
                prCiStatus={worktree.linked?.pr?.ciStatus}
                isSubordinate={false}
                worktreePath={worktree.path}
                onOpen={badges.onOpenPR}
                isHeadline
                isActive={isActive}
                underlineOnHover={underlineOnHover}
              />
            ) : (
              <IssueBadge
                issueNumber={worktree.issueNumber!}
                issueTitle={displayTitle}
                worktreePath={worktree.path}
                onOpen={badges.onOpenIssue}
                isHeadline
                isActive={isActive}
                underlineOnHover={underlineOnHover}
              />
            )
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
          {gitStateIndicator && (
            <span
              className={cn(
                "text-xs font-medium shrink-0 pointer-events-none",
                gitStateIndicator.tone === "error" && "text-status-error",
                gitStateIndicator.tone === "warning" && "text-status-warning"
              )}
            >
              {gitStateIndicator.label}
            </span>
          )}
          {isCollapsed && <CollapsedAlarmPill alarm={collapsedAlarm} />}
        </div>

        {((isPinned && !isMainWorktree) ||
          isProjectNotificationsMuted ||
          (worktree.worktreeMode && worktree.worktreeMode !== "local") ||
          resourceStatusLabel ||
          isLifecycleRunning ||
          hasDevServerSignal ||
          hasFreshnessPill) && (
          <div className="flex items-center gap-2 shrink-0">
            {isPinned && !isMainWorktree && (
              <Pin
                className="w-3.5 h-3.5 text-daintree-text/40 shrink-0 pointer-events-none"
                aria-label="Pinned"
              />
            )}
            {isProjectNotificationsMuted && (
              <BellOff
                className="w-3.5 h-3.5 text-daintree-text/40 shrink-0 pointer-events-none"
                aria-label="Notifications muted for this project"
              />
            )}
            <GitStatusFreshnessPill
              lastGitStatusCheckedAt={lastGitStatusCheckedAt}
              onRefresh={onRevalidateGitStatus}
            />
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
                className="w-3.5 h-3.5 text-daintree-text/40"
              />
            )}
            <DevServerIndicator session={devServerSession} />
          </div>
        )}

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

      {showBlockingOpRow &&
        blockingOpKind &&
        onAbortRepositoryOperation &&
        onContinueRepositoryOperation && (
          <BlockingOpRow
            kind={blockingOpKind}
            hasUnresolvedConflicts={hasUnresolvedConflicts}
            onAbort={onAbortRepositoryOperation}
            onContinue={onContinueRepositoryOperation}
          />
        )}

      {!isCollapsed && isMainStandardLayout && (
        <MainWorktreeSecondaryRow
          branchLabel={branchLabel}
          isActive={isActive}
          isMuted={isMuted}
          hasUpstreamDelta={hasUpstreamDelta}
          hasAuthFailedSignIn={hasAuthFailedSignIn}
          authProviderId={worktree.matchedForgeProviderId ?? worktree.linked?.providerId ?? null}
          aheadCount={worktree.aheadCount}
          behindCount={worktree.behindCount}
          isFetchInFlight={Boolean(worktree.isFetchInFlight)}
          lastFetchedAt={worktree.lastFetchedAt}
          fetchAuthFailed={Boolean(worktree.fetchAuthFailed)}
          fetchNetworkFailed={Boolean(worktree.fetchNetworkFailed)}
          aggregateCounts={aggregateCounts}
        />
      )}

      {!isCollapsed &&
        !isMainStandardLayout &&
        (hasDisplayTitle ||
          worktree.issueNumber ||
          (worktree.linked?.pr &&
            worktree.linked.pr.state !== "closed" &&
            worktree.linked.pr.state !== "declined") ||
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
            hasDisplayTitle={hasDisplayTitle}
            isPrOriginated={isPrOriginated}
            hasPlanFile={hasPlanFile}
            badges={badges}
          />
        )}
    </div>
  );
}
