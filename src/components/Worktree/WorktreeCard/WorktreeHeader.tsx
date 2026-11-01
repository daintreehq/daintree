import { useMemo } from "react";
import type { AgentState, WorktreeState } from "@/types";
import type { WorktreeMenuActions } from "../WorktreeMenuItems";
import type { GitStateIndicator } from "./hooks/useWorktreeStatus";
import { cn } from "@/lib/utils";
import { summarizeSessionStates } from "../terminalStateConfig";
import { BranchLabel } from "../BranchLabel";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { Sprout, Pin, BellOff } from "lucide-react";
import { FolderOutput } from "@/components/icons";
import type { AggregateCounts } from "./aggregateCounts";
import { PRBadge } from "./PRBadge";
import { useColdNumberGap } from "./hooks/useColdNumberGap";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";
import { EnvironmentPopover } from "./EnvironmentPopover";
import { WorktreeAttachmentChips } from "./WorktreeAttachmentChips";
import { visibleAttachmentChips } from "./attachmentState";
import { WorktreePluginStatusChips, useWorktreePluginStatuses } from "./WorktreePluginStatusChips";
import { DevServerIndicator } from "./DevServerIndicator";
import { devServerSummaryText, summarizeDevServer } from "@/lib/devServerPresentation";
import { CollapsedSessionIndicators } from "./CollapsedSessionIndicators";
import {
  AttentionMark,
  CollapsedAlarmPill,
  collapsedAlarmDescriptionId,
} from "./CollapsedAlarmPill";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { worktreeRowDescriptionId } from "./rowDescriptions";
import { isExternalWorktree, isLiveDevServerStatus } from "@/lib/worktreeFilters";
import { getWorktreeHeadline } from "@/lib/worktreeHeadline";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import { WorktreeActionsToolbar } from "./WorktreeActionsToolbar";
import { SECTION_TEXT_COLUMN } from "./sectionChrome";
import { WorktreeDensitySubmenu } from "../WorktreeDensitySubmenu";
import { MainWorktreeSecondaryRow } from "./MainWorktreeSecondaryRow";
import { NonMainSecondaryRow } from "./NonMainSecondaryRow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  computeAlarmTier,
  formatAlarmDetail,
  isPullRequestWarning,
  type AlarmDescriptor,
} from "@/lib/worktreeAlarmTier";
import { PathSegments } from "@/components/ui/PathSegments";

const NO_ALARM: AlarmDescriptor = { tier: 0, kind: "none", label: "", tone: "none" };

export interface WorktreeHeaderProps {
  worktree: WorktreeState;
  isActive: boolean;
  variant?: "sidebar" | "grid";
  /** Sidebar only: compact packs the stack; comfortable gives each fact a line. */
  density?: "comfortable" | "compact";
  isMuted?: boolean;
  isProjectNotificationsMuted?: boolean;
  isMainWorktree: boolean;
  isMainOnStandardBranch?: boolean;
  isPinned: boolean;
  isCollapsed?: boolean;
  /** The card's select button has `:focus-visible`; opens the collapsed alarm's tooltip. */
  isKeyboardFocused?: boolean;
  canCollapse?: boolean;
  onToggleCollapse?: (e: React.MouseEvent) => void;
  contentId?: string;
  branchLabel: string;
  /** Normalised custom title (#13409); takes the headline slot when set. */
  customTitle?: string;
  /** Names the worktree in its controls' accessible names. */
  worktreeLabel?: string;
  sessionStates?: Record<AgentState, number>;
  sessionTotal?: number;
  /** Unread hand-backs, counted apart from `sessionStates`. */
  sessionUnread?: number;
  aggregateCounts?: AggregateCounts;
  environmentIcon?: string;
  isLifecycleRunning?: boolean;
  resourceStatusLabel?: string;
  resourceStatusColor?: "green" | "yellow" | "red" | "neutral";
  resourceLastOutput?: string;
  resourceEndpoint?: string;
  resourceLastCheckedAt?: number;
  devServerSession?: DevPreviewSessionState;
  onCheckResourceStatus?: () => void | Promise<unknown>;
  onPreviewEndpoint?: () => void;
  /** Opens the worktree on the machine its resource reported; omitted where that can't be offered. */
  onOpenOnHost?: () => void;
  onAttachmentAction?: (name: string, action: "detach" | "status") => void;
  onCleanupWorktree?: () => void;
  badges: {
    onOpenIssue?: () => void;
    onOpenPR?: () => void;
    onOpenPlan?: () => void;
  };

  gitStateIndicator: GitStateIndicator | null;

  /** A setup or lifecycle run that failed or is waiting on approval; drawn in the title row's attention column. */
  lifecycleAlarm?: { tone: "error" | "warning"; label: string } | null;
  /**
   * The open card's own body already shows the git state (Details' resting
   * row says "Conflicts need review") or the setup alarm (its recovery and
   * approval blocks), so the title-row mark would say it a second time.
   */
  gitStateShownInBody?: boolean;
  lifecycleAlarmShownInBody?: boolean;

  /** The presentation profile quiets git detail (#13777); see `NonMainSecondaryRow`. */
  quietGit?: boolean;

  menu: WorktreeMenuActions;
}

export function WorktreeHeader({
  worktree,
  isActive,
  variant = "sidebar",
  density = "compact",
  isMuted,
  isProjectNotificationsMuted,
  isMainWorktree,
  isMainOnStandardBranch,
  isPinned,
  isCollapsed,
  isKeyboardFocused,
  canCollapse,
  onToggleCollapse,
  contentId,
  branchLabel,
  customTitle,
  worktreeLabel,
  sessionStates,
  sessionTotal,
  sessionUnread,
  aggregateCounts,
  environmentIcon,
  isLifecycleRunning,
  resourceStatusLabel,
  resourceStatusColor,
  resourceLastOutput,
  resourceEndpoint,
  resourceLastCheckedAt,
  devServerSession,
  onCheckResourceStatus,
  onPreviewEndpoint,
  onOpenOnHost,
  onAttachmentAction,
  onCleanupWorktree,
  badges,
  gitStateIndicator,
  lifecycleAlarm,
  gitStateShownInBody = false,
  lifecycleAlarmShownInBody = false,
  quietGit = false,
  menu,
}: WorktreeHeaderProps) {
  const showGitStateMark = !!gitStateIndicator && variant === "sidebar" && !gitStateShownInBody;
  const showLifecycleMark = !!lifecycleAlarm && variant === "sidebar" && !lifecycleAlarmShownInBody;
  // The headline cascade lives in `getWorktreeHeadline` so the compact surfaces
  // that list worktrees render the same title this card does. PR-originated
  // worktrees (created from the PR dropdown, #8888) invert the default
  // issue-first headline: the PR title leads, with the linked issue shown
  // underneath, and it renders even during the cold-title gap (→ "#NNN").
  //
  // A custom title (#13409) replaces only the label, so the kind below is still
  // the computed one. Provenance reads `sourcePrNumber` regardless, so it can
  // never follow whatever the headline slot happens to show.
  const headline = getWorktreeHeadline(worktree, customTitle);
  const hasCustomTitle = headline.customTitle !== undefined;
  const isPrOriginated = Boolean(worktree.sourcePrNumber);
  const hasDisplayTitle = headline.kind === "pr" || headline.kind === "issue";
  const displayTitle =
    headline.kind === "pr" || headline.kind === "issue" ? headline.title : undefined;
  // A PR headline can arrive before its title. Its number stands in once the
  // cold-number window has passed, as it did when the headline was the badge
  // (#8079), so the card never names itself with nothing.
  const hideColdPrNumber = useColdNumberGap(
    headline.kind === "pr" ? headline.number : 0,
    displayTitle,
    headline.kind === "pr"
  );
  const headlineTitleText =
    displayTitle || (headline.kind === "pr" && !hideColdPrNumber ? `#${headline.number}` : "");
  const hasPlanFile = Boolean(worktree.hasPlanFile);
  const hasDevServerSignal = !!devServerSession && isLiveDevServerStatus(devServerSession.status);
  const devServerSummary = devServerSession ? summarizeDevServer(devServerSession) : null;
  const devServerDescription = devServerSummary ? devServerSummaryText(devServerSummary) : null;
  const hasAttachmentChips =
    !!onAttachmentAction && visibleAttachmentChips(worktree.attachments).length > 0;
  const pluginStatuses = useWorktreePluginStatuses(worktree.id);
  // `hasBaseName` is the whole mount rule for the base line: the workspace-host
  // sets it only for a non-main worktree on a branch whose base it resolved, so
  // it is exactly "this is a branch, and we know what it is measured against".
  // The line renders at rest too (`≡ develop`), because a worktree sitting on
  // its base with no upstream yet — the state every worktree is created in
  // since `87dc51fa9` stopped pointing new branches at their base — otherwise
  // said nothing at all about where it came from.
  //
  // `hasUpstreamDelta` is now only the alarm question, and keeps both rules it
  // was given. No `!baseMatchesUpstream` term: when the two agree the badge
  // renders the labelled base form rather than nothing, so gating on the
  // disagreement would hide the very line that names what the counts mean. And
  // the base terms require `baseBranchName`, because that is what the badge
  // requires to draw them.
  const hasBaseName = worktree.baseBranchName != null;
  // Detached HEAD keeps the pre-detach branch name in the producer, so the base
  // name outlives the branch it described. The relationship row is a claim
  // about a branch, so it does not mount without one; the drift row still does,
  // via `hasUpstreamDelta`.
  const hasBaseRelationship = hasBaseName && !worktree.isDetached;
  // The sync line has something to say beyond counts and a base — a failed
  // fetch, a missing upstream — once a fetch or
  // a status pass has run. Whether it actually says anything is the badge's
  // call; the row collapses when nothing in it renders.
  const hasSyncFacts =
    Boolean(worktree.fetchAuthFailed || worktree.fetchNetworkFailed) ||
    (!worktree.isDetached && (worktree.lastFetchedAt != null || worktree.worktreeChanges != null));
  const hasUpstreamDelta =
    (worktree.aheadCount ?? 0) > 0 ||
    (worktree.behindCount ?? 0) > 0 ||
    (hasBaseName && (worktree.baseAheadCount ?? 0) > 0) ||
    (hasBaseName && (worktree.baseBehindCount ?? 0) > 0);
  const hasAuthFailedSignIn = Boolean(
    worktree.fetchAuthFailed &&
    (worktree.matchedForgeProviderId != null || worktree.linked?.providerId != null)
  );
  // Stays on the prop rather than `headline.kind === "main"`. The prop is the
  // caller's override, and omitting it means "render the branch" even for a
  // main worktree that would satisfy the rule on its own — `getWorktreeHeadline`
  // derives that rule from the worktree alone, which is what a standalone
  // consumer needs and what this component must not assume.
  const isMainStandardLayout = !!(isMainOnStandardBranch && !hasDisplayTitle);
  const isExternal = isExternalWorktree(worktree);
  // On the sidebar the title outranks infrastructure: a port or attachment
  // name took 60% of the active card's title row at the default width and the
  // whole of it at the narrowest. Below 28rem the glyphs stay and the words
  // move to their tooltips and accessible names.
  // A comfortable card keeps the words down to 20rem: it has the extra line
  // budget, and the name is the part of a dev server worth reading.
  const isCompact = variant === "sidebar" && density === "compact";
  const compactTrailingLabel =
    variant !== "sidebar"
      ? undefined
      : isCompact
        ? "hidden @md/card:inline"
        : "hidden @xs/card:inline";
  // Below 20rem healthy infrastructure gives way entirely; a failure never
  // does. Every glyph it hides is also reachable from the card's menus.
  const narrowHide = variant === "sidebar" ? "hidden @xs/card:inline-flex" : undefined;
  const hasFailedAttachment = visibleAttachmentChips(worktree.attachments).some(
    (chip) => chip.state.tone === "error"
  );

  const prState = worktree.linked?.pr?.state;
  const isPrLive = prState !== undefined && prState !== "closed" && prState !== "declined";
  const ciStatus = isPrLive ? worktree.linked?.pr?.ciStatus : undefined;
  const ciState = ciStatus?.state;
  // Tier and detail in one memo: they describe the same alarm, so deriving
  // them from two different snapshots of the counts would let the pill say
  // "Behind" over a line that names no drift.
  const { collapsedAlarm, collapsedAlarmDetail } = useMemo(() => {
    const alarm = computeAlarmTier({
      ciState,
      authFailed: hasAuthFailedSignIn,
      behindCount: worktree.behindCount,
      baseBehindCount: worktree.baseBehindCount,
    });
    return {
      collapsedAlarm: alarm,
      collapsedAlarmDetail: formatAlarmDetail(alarm.kind, {
        aheadCount: worktree.aheadCount,
        behindCount: worktree.behindCount,
        baseAheadCount: worktree.baseAheadCount,
        baseBehindCount: worktree.baseBehindCount,
        baseBranchName: worktree.baseBranchName,
        baseCompareRef: worktree.baseCompareRef,
        baseMatchesUpstream: worktree.baseMatchesUpstream,
        ciFailed: ciStatus?.failed,
        ciTotal: ciStatus?.total,
      }),
    };
  }, [
    ciState,
    ciStatus?.failed,
    ciStatus?.total,
    hasAuthFailedSignIn,
    worktree.aheadCount,
    worktree.behindCount,
    worktree.baseAheadCount,
    worktree.baseBehindCount,
    worktree.baseBranchName,
    worktree.baseCompareRef,
    worktree.baseMatchesUpstream,
  ]);
  const isAlarmShownInStack =
    collapsedAlarm.kind === "auth-failed" ||
    (collapsedAlarm.kind === "ci-failed" && !isMainStandardLayout);

  // Quiet git detail (#13777) keeps the headline's words and moves the issue or
  // PR mark and the branch into its tooltip. A cold PR headline with no title
  // yet has no words to keep, so it stays the badge until the title arrives,
  // and so does a PR headline that warns: on a collapsed card nothing else
  // would show that its head moved under an armed merge.
  const prDetectionPaused = usePRCircuitBreakerStore((s) => s.tripped);
  const showCollapsedPrReference =
    !!isCollapsed &&
    isPrOriginated &&
    !hasCustomTitle &&
    headline.kind === "pr" &&
    isPullRequestWarning(worktree.linked?.pr);

  const quietHeadlineTitle =
    quietGit && !hasCustomTitle && !(isPrOriginated && isPullRequestWarning(worktree.linked?.pr))
      ? displayTitle
      : undefined;
  // A custom title's displaced headline already carries the mark.
  const quietDisplaced = [
    hasCustomTitle
      ? undefined
      : headline.kind === "pr"
        ? `Pull request #${headline.number}`
        : headline.kind === "issue"
          ? `Issue ${worktree.issueKey ?? `#${headline.number}`}`
          : undefined,
    headline.computedLabel,
    branchLabel,
  ].filter(
    (line, i, lines): line is string =>
      Boolean(line) && line !== quietHeadlineTitle && lines.indexOf(line) === i
  );

  const { visibleStates, label: sessionAriaLabel } = useMemo(
    () =>
      sessionStates && sessionTotal
        ? summarizeSessionStates(sessionStates, sessionTotal, sessionUnread)
        : { visibleStates: [], label: "" },
    [sessionStates, sessionTotal, sessionUnread]
  );

  return (
    <div>
      <div className="flex items-center gap-2 min-h-[22px]">
        {/* min-w-12: on the narrowest sidebar the title keeps a recognisable
            stem before anything trailing is allowed to take its width. */}
        <div
          className={cn(
            "flex items-center gap-2 flex-1",
            variant === "sidebar" ? "min-w-12" : "min-w-0"
          )}
        >
          {isMainWorktree && (
            <Sprout
              className="w-3.5 h-3.5 text-text-secondary shrink-0 pointer-events-none"
              aria-hidden="true"
            />
          )}
          {hasCustomTitle ? (
            <CustomTitleHeadline
              title={headline.customTitle!}
              displaced={
                quietGit
                  ? quietDisplaced
                  : isCollapsed
                    ? [headline.computedLabel!, branchLabel].filter(
                        (line, i, lines) => line && lines.indexOf(line) === i
                      )
                    : isMainStandardLayout
                      ? [worktree.name]
                      : []
              }
              isActive={isActive}
              isMuted={isMuted}
            />
          ) : quietHeadlineTitle ? (
            <CustomTitleHeadline
              title={quietHeadlineTitle}
              displaced={quietDisplaced}
              isActive={isActive}
              isMuted={isMuted}
            />
          ) : hasDisplayTitle ? (
            // The issue or PR title, as words: the headline names the
            // worktree, and a click on it selects the card like any of the
            // card's content. It used to be the issue/PR badge itself, which
            // selected an inactive card but opened the browser from the active
            // one — the same click leaving the app depending on which card
            // was current (#15864). The reference that opens it is its own
            // control in the stack below.
            <CustomTitleHeadline
              title={headlineTitleText}
              displaced={[]}
              isActive={isActive}
              isMuted={isMuted}
              testId="worktree-headline-title"
            />
          ) : isMainStandardLayout && quietGit ? (
            <CustomTitleHeadline
              title={worktree.name}
              displaced={[branchLabel]}
              isActive={isActive}
              isMuted={isMuted}
            />
          ) : isMainStandardLayout ? (
            <TruncatedTooltip content={worktree.name}>
              <span
                className={cn(
                  "truncate text-sm leading-[inherit] transition-colors duration-150",
                  isActive
                    ? "text-text-primary font-medium"
                    : isMuted
                      ? // Muted, not unreadable. This is the card's headline —
                        // the only thing naming which worktree it is — and
                        // `text-text-muted` has no dark contrast floor in this
                        // cohort (2.22:1 on namib). The de-emphasis comes off
                        // the weight instead, which costs nothing legible.
                        "text-text-secondary font-normal"
                      : "text-text-secondary font-medium"
                )}
                data-testid="primary-worktree-project-name"
              >
                {worktree.name}
              </span>
            </TruncatedTooltip>
          ) : (
            <BranchLabel label={branchLabel} isActive={isActive} isMuted={isMuted} />
          )}
          {/* A collapsed card has no stack for the PR reference to sit in, and
              the collapsed alarm pill has no word for a head that moved under
              an armed merge. So a PR headline that warns keeps its reference
              beside the title, where the warning was before the headline
              became words. */}
          {showCollapsedPrReference && (
            // The title gives way first; the number and its warning do not.
            <span className="flex shrink-0">
              <PRBadge
                prNumber={worktree.sourcePrNumber!}
                prState={worktree.linked?.pr?.state}
                prCiStatus={worktree.linked?.pr?.ciStatus}
                mergeIntent={worktree.linked?.pr?.mergeIntent}
                headMovedWhileArmed={worktree.linked?.pr?.headMovedWhileArmed}
                isSubordinate={false}
                worktreePath={worktree.path}
                onOpen={badges.onOpenPR}
                worktreeLabel={worktreeLabel}
                prDetectionPaused={prDetectionPaused}
              />
            </span>
          )}
          {/* The grid keeps the word beside its title; the sidebar draws it as
              a pill in the title row's attention column. */}
          {gitStateIndicator && variant !== "sidebar" && (
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
        </div>

        {((isPinned && !isMainWorktree) ||
          isExternal ||
          isProjectNotificationsMuted ||
          (worktree.worktreeMode && worktree.worktreeMode !== "local") ||
          resourceStatusLabel ||
          isLifecycleRunning ||
          onCheckResourceStatus ||
          hasDevServerSignal ||
          hasAttachmentChips) && (
          <div
            className={cn(
              "flex items-center gap-2",
              // The sidebar's cluster may give way to the title; the grid's
              // keeps its full width as before.
              variant === "sidebar" ? "min-w-0 shrink" : "shrink-0"
            )}
          >
            {isPinned && !isMainWorktree && (
              <Pin
                className={cn(
                  "w-3.5 h-3.5 text-text-secondary shrink-0 pointer-events-none",
                  narrowHide
                )}
                aria-label="Pinned"
              />
            )}
            {isExternal && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="img"
                    aria-label={`External worktree at ${worktree.path}`}
                    className={cn("shrink-0 leading-none", narrowHide)}
                  >
                    <FolderOutput className="w-3.5 h-3.5 text-text-secondary" aria-hidden="true" />
                  </span>
                </TooltipTrigger>
                {/* Plain-text label: the path renders one box per folder, and
                    Chromium puts a space between such boxes when it computes
                    the tooltip's accessible text ("/ repo/ my project"). */}
                <TooltipContent
                  side="bottom"
                  className="max-w-xs"
                  aria-label={`Outside the project directory ${worktree.path}`}
                >
                  <span className="block">Outside the project directory</span>
                  <span className="mt-0.5 block font-mono text-2xs">
                    <PathSegments path={worktree.path} />
                  </span>
                </TooltipContent>
              </Tooltip>
            )}
            {isExternal && variant === "sidebar" && (
              // For the card's select button to be described by, which only the
              // sidebar card has; see rowDescriptions.
              <span id={worktreeRowDescriptionId(worktree.id, "external")} hidden>
                {`External worktree at ${worktree.path}`}
              </span>
            )}
            {isProjectNotificationsMuted && (
              <BellOff
                className={cn(
                  "w-3.5 h-3.5 text-text-secondary shrink-0 pointer-events-none",
                  narrowHide
                )}
                aria-label="Notifications muted for this project"
              />
            )}
            {((worktree.worktreeMode && worktree.worktreeMode !== "local") ||
              resourceStatusLabel ||
              isLifecycleRunning ||
              onCheckResourceStatus) && (
              <span
                className={cn(
                  "inline-flex shrink-0",
                  resourceStatusColor !== "red" && !isLifecycleRunning && narrowHide
                )}
              >
                <EnvironmentPopover
                  worktreeMode={worktree.worktreeMode}
                  environmentIcon={environmentIcon}
                  isLifecycleRunning={isLifecycleRunning}
                  lifecycle={worktree.lifecycleStatus}
                  resourceStatusLabel={resourceStatusLabel}
                  resourceStatusColor={resourceStatusColor}
                  reportedStatus={worktree.resourceStatus?.lastStatus}
                  resourceLastOutput={resourceLastOutput}
                  resourceEndpoint={resourceEndpoint}
                  resourceLastCheckedAt={resourceLastCheckedAt}
                  onCheckResourceStatus={onCheckResourceStatus}
                  onPreviewEndpoint={onPreviewEndpoint}
                  resourceSsh={worktree.resourceStatus?.ssh}
                  onOpenOnHost={onOpenOnHost}
                />
              </span>
            )}
            {hasAttachmentChips && onAttachmentAction && (
              <span
                className={cn(
                  "inline-flex min-w-0 shrink items-center gap-2",
                  !hasFailedAttachment && narrowHide
                )}
              >
                <WorktreeAttachmentChips
                  attachments={worktree.attachments}
                  onAction={onAttachmentAction}
                  nameClassName={compactTrailingLabel}
                />
              </span>
            )}
            <span
              className={cn(
                "inline-flex shrink-0 empty:hidden",
                devServerSession?.status !== "error" && narrowHide
              )}
            >
              <DevServerIndicator
                session={devServerSession}
                labelClassName={compactTrailingLabel}
              />
            </span>
            {hasDevServerSignal && variant === "sidebar" && devServerDescription && (
              // For the card's select button to be described by; see rowDescriptions.
              <span id={worktreeRowDescriptionId(worktree.id, "devServer")} hidden>
                {devServerDescription}
              </span>
            )}
          </div>
        )}

        {/* Everything on the card that needs the user, as one pill shape in
            one column, open or collapsed: a blocking git state, a setup that
            failed or wants approval, failing CI or a failed sign-in. Always
            ahead of the session glyphs, never straight after the title, so
            the column does not move with the title's length. Drift alone is
            ambient, not an alarm (tier 1): most branches are a few commits
            behind their base, and a pill on each buried the one that failed. */}
        {gitStateIndicator && showGitStateMark && (
          <AttentionMark
            tone={gitStateIndicator.tone}
            label={gitStateIndicator.label}
            Icon={SEVERITY_GLYPH[gitStateIndicator.tone]}
            testId="worktree-git-state-mark"
            revealed={isKeyboardFocused}
          />
        )}
        {lifecycleAlarm && showLifecycleMark && (
          <AttentionMark
            tone={lifecycleAlarm.tone}
            label={lifecycleAlarm.label}
            Icon={SEVERITY_GLYPH[lifecycleAlarm.tone]}
            testId="worktree-lifecycle-mark"
            // One reveal at a time: the leftmost mark speaks for the column.
            revealed={isKeyboardFocused && !showGitStateMark}
          />
        )}
        {variant === "sidebar" && (
          // For the card's select button to be described by; see rowDescriptions.
          <span id={worktreeRowDescriptionId(worktree.id, "attention")} hidden>
            {/* The session states too: the select button is what a screen
                reader lands on as the cursor moves, and the glyphs beside the
                title are pictures it cannot reach. */}
            {[gitStateIndicator?.label, lifecycleAlarm?.label, sessionAriaLabel]
              .filter(Boolean)
              .join(". ")}
          </span>
        )}
        {/* An open card raises the pill only for an alarm its own lines don't
            already show: a failed CI is on the PR badge (stack or headline) of
            every non-main card, and a failed sign-in on its sync line, so a
            pill there would say the same thing twice on one card. */}
        {(isCollapsed || variant === "sidebar") && (
          <CollapsedAlarmPill
            alarm={
              collapsedAlarm.tier >= 2 && (isCollapsed || !isAlarmShownInStack)
                ? collapsedAlarm
                : NO_ALARM
            }
            detail={collapsedAlarmDetail}
            descriptionId={collapsedAlarmDescriptionId(worktree.id)}
            spokenAlarm={collapsedAlarm.tier >= 2 ? collapsedAlarm : undefined}
            revealed={
              isKeyboardFocused &&
              (variant !== "sidebar" || (!showGitStateMark && !showLifecycleMark))
            }
          />
        )}

        {/* Every sidebar card draws session state here, open or collapsed, in
            either density, so a waiting ring always lands in the same column
            of every card's first line. On the Sessions row it sat four to
            eight lines down a card of varying height, and finding who was
            waiting meant reading each card's bottom corner. */}
        {(isCollapsed || variant === "sidebar") && visibleStates.length > 0 && (
          <CollapsedSessionIndicators
            visibleStates={visibleStates}
            sessionAriaLabel={sessionAriaLabel}
            secondaryClassName={variant === "sidebar" ? "hidden @xs/card:flex" : undefined}
          />
        )}

        <WorktreeActionsToolbar
          managedByGrid={variant === "sidebar"}
          viewSubmenu={
            variant === "sidebar" ? (
              <WorktreeDensitySubmenu
                key="view"
                kind="dropdown"
                iconClassName="mr-2 h-3.5 w-3.5 shrink-0"
              />
            ) : undefined
          }
          isCollapsed={isCollapsed ?? false}
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
          variant={variant}
          density={density}
          branchLabel={branchLabel}
          isActive={isActive}
          isMuted={isMuted}
          hasAuthFailedSignIn={hasAuthFailedSignIn}
          aheadCount={worktree.aheadCount}
          behindCount={worktree.behindCount}
          isFetchInFlight={Boolean(worktree.isFetchInFlight)}
          lastFetchedAt={worktree.lastFetchedAt}
          fetchAuthFailed={Boolean(worktree.fetchAuthFailed)}
          fetchNetworkFailed={Boolean(worktree.fetchNetworkFailed)}
          aggregateCounts={aggregateCounts}
          quietGit={quietGit}
        />
      )}

      {!isCollapsed &&
        !isMainStandardLayout &&
        (hasDisplayTitle ||
          hasCustomTitle ||
          worktree.issueNumber ||
          (worktree.linked?.pr &&
            worktree.linked.pr.state !== "closed" &&
            worktree.linked.pr.state !== "declined") ||
          hasUpstreamDelta ||
          hasBaseRelationship ||
          hasAuthFailedSignIn ||
          hasSyncFacts ||
          hasPlanFile) && (
          <NonMainSecondaryRow
            variant={variant}
            density={density}
            worktree={worktree}
            branchLabel={branchLabel}
            isActive={isActive}
            isMuted={isMuted}
            worktreeLabel={worktreeLabel}
            hasUpstreamDelta={hasUpstreamDelta}
            hasAuthFailedSignIn={hasAuthFailedSignIn}
            hasDisplayTitle={hasDisplayTitle}
            hasCustomTitle={hasCustomTitle}
            isPrOriginated={isPrOriginated}
            hasPlanFile={hasPlanFile}
            quietGit={quietGit}
            badges={badges}
          />
        )}

      {/* Its own wrapping row, so any number of plugins can mark a card
          without squeezing the headline out of the row above. */}
      {!isCollapsed && pluginStatuses.length > 0 && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-1",
            SECTION_TEXT_COLUMN,
            isCompact ? "mt-1" : "mt-1.5"
          )}
        >
          <WorktreePluginStatusChips worktreeId={worktree.id} statuses={pluginStatuses} />
        </div>
      )}
    </div>
  );
}

/**
 * The custom title in the headline slot, in the headline's own type. With
 * something displaced to name — the project on main, or the computed headline
 * and branch on a collapsed card, where the stack beneath is hidden — the
 * tooltip always carries it; otherwise it only discloses a truncated title.
 */
function CustomTitleHeadline({
  title,
  displaced,
  isActive,
  isMuted,
  testId = "worktree-custom-title",
}: {
  title: string;
  displaced: string[];
  isActive: boolean;
  isMuted?: boolean;
  testId?: string;
}) {
  const span = (
    <span
      className={cn(
        "truncate text-sm leading-[inherit] transition-colors duration-150",
        isActive
          ? "text-text-primary font-medium"
          : isMuted
            ? "text-text-secondary font-normal"
            : "text-text-secondary font-medium"
      )}
      data-testid={testId}
    >
      {title}
    </span>
  );
  if (displaced.length === 0) {
    return <TruncatedTooltip content={title}>{span}</TruncatedTooltip>;
  }
  // A full-identity reveal, so it stays while hovered or focused rather than
  // taking the 2.5s hint deadline (WCAG 1.4.13).
  return (
    <Tooltip autoDismiss={false} disableHoverableContent={false}>
      <TooltipTrigger asChild>{span}</TooltipTrigger>
      <TooltipContent
        side="bottom"
        className="max-w-xs"
        data-testid="worktree-custom-title-tooltip"
      >
        <span className="block font-medium">{title}</span>
        {displaced.map((line) => (
          <span key={line} className="mt-0.5 block text-text-secondary">
            {line}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
