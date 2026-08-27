import { useEffect, useMemo, useState } from "react";
import type { AgentState, WorktreeState } from "@/types";
import type { WorktreeMenuActions } from "../WorktreeMenuItems";
import type { GitStateIndicator } from "./hooks/useWorktreeStatus";
import type { ChipState } from "../utils/computeChipState";
import { cn } from "@/lib/utils";
import { STATE_LABELS, STATE_PRIORITY } from "../terminalStateConfig";
import { BranchLabel } from "../BranchLabel";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { Sprout, Pin, BellOff, RefreshCw } from "lucide-react";
import { FolderOutput } from "@/components/icons";
import type { AggregateCounts } from "./MainWorktreeSummaryRows";
import { IssueBadge } from "./IssueBadge";
import { PRBadge } from "./PRBadge";
import { EnvironmentPopover } from "./EnvironmentPopover";
import { DevServerIndicator } from "./DevServerIndicator";
import { CollapsedSessionIndicators } from "./CollapsedSessionIndicators";
import { CollapsedAlarmPill } from "./CollapsedAlarmPill";
import { isExternalWorktree, isLiveDevServerStatus } from "@/lib/worktreeFilters";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import { WorktreeActionsToolbar } from "./WorktreeActionsToolbar";
import { MainWorktreeSecondaryRow } from "./MainWorktreeSecondaryRow";
import { NonMainSecondaryRow } from "./NonMainSecondaryRow";
import { scheduleFlip } from "@/utils/flipScheduler";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { computeAlarmTier } from "@/lib/worktreeAlarmTier";

/** Shared by the dot's tooltip and its accessible name, so they cannot drift. */
const CHIP_LABELS: Record<Exclude<ChipState, null>, string> = {
  waiting: "Agent waiting for input",
  cleanup: "Ready for cleanup",
  complete: "Complete: in review",
};

export interface WorktreeHeaderProps {
  worktree: WorktreeState;
  isActive: boolean;
  variant?: "sidebar" | "grid";
  isMuted?: boolean;
  isProjectNotificationsMuted?: boolean;
  isMainWorktree: boolean;
  isMainOnStandardBranch?: boolean;
  isPinned: boolean;
  chipState: ChipState;
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

  menu: WorktreeMenuActions;
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

export function WorktreeHeader({
  worktree,
  isActive,
  variant = "sidebar",
  isMuted,
  isProjectNotificationsMuted,
  isMainWorktree,
  isMainOnStandardBranch,
  isPinned,
  chipState,
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
  menu,
}: WorktreeHeaderProps) {
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
  const isExternal = isExternalWorktree(worktree);

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

        {(chipState !== null ||
          (isPinned && !isMainWorktree) ||
          isExternal ||
          isProjectNotificationsMuted ||
          (worktree.worktreeMode && worktree.worktreeMode !== "local") ||
          resourceStatusLabel ||
          isLifecycleRunning ||
          hasDevServerSignal ||
          hasFreshnessPill) && (
          <div className="flex items-center gap-2 shrink-0">
            {/* Worktree-level state — waiting / ready-for-cleanup / complete.
                A dot, and in the title row, because it used to be a 12px
                triangle clipped into the card's top-left corner. That corner
                is the worst place for it now: it abuts the gutter and the
                neighbouring card, so the one mark whose job is to say "this
                card needs you" was the mark with the weakest claim to a card.
                A corner ribbon also cannot be given a focus ring or a sane
                bounding box, and it is a bespoke shape for an app concept.

                `computeChipState` returns one state or none, never a
                combination, which is exactly what a dot encodes. It sits with
                the other non-interactive indicators rather than beside the
                title's leading glyph, so the card keeps one leading mark
                instead of two competing ones. */}
            {chipState !== null && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="img"
                    aria-label={CHIP_LABELS[chipState]}
                    className={cn(
                      // status-mark: the fill is the whole signal, so forced
                      // colors has to repaint it rather than flatten it to the
                      // canvas.
                      "status-mark h-2 w-2 shrink-0 rounded-full",
                      chipState === "waiting" && "bg-activity-waiting",
                      chipState === "cleanup" && "bg-pr-merged",
                      chipState === "complete" && "bg-category-blue"
                    )}
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom">{CHIP_LABELS[chipState]}</TooltipContent>
              </Tooltip>
            )}
            {isPinned && !isMainWorktree && (
              <Pin
                className="w-3.5 h-3.5 text-daintree-text/40 shrink-0 pointer-events-none"
                aria-label="Pinned"
              />
            )}
            {isExternal && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="img"
                    aria-label={`External worktree at ${worktree.path}`}
                    className="shrink-0 leading-none"
                  >
                    <FolderOutput
                      className="w-3.5 h-3.5 text-daintree-text/40"
                      aria-hidden="true"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <span className="block">Outside the project directory</span>
                  <span className="mt-0.5 block font-mono text-[11px] break-all">
                    {worktree.path}
                  </span>
                </TooltipContent>
              </Tooltip>
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
          menu={menu}
          worktree={worktree}
          isPinned={isPinned}
        />
      </div>

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
