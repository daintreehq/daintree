import type React from "react";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { DiffStat } from "@/components/ui/DiffStat";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { prefetchStagingStatus } from "@/components/Worktree/ReviewHub/stagingStatusCache";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { WorktreeState } from "@/types";
import type { RetryAction } from "@/store";
import type { ErrorRecord } from "@/store/errorStore";
import { useShouldSkipMotion } from "@/hooks/useShouldSkipMotion";
import { DURATION_200 } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { WorktreeDetails } from "../WorktreeDetails";
import { WorktreeActivityChip } from "./WorktreeActivityChip";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/Spinner";
import { Callout } from "@/components/ui/Callout";
import { useForgeAuthorAvatar } from "@/hooks/useForgeAuthorAvatar";
import { useReviewChangeHint } from "@/hooks/useReviewChangeHint";
import {
  Activity,
  ChevronRight,
  GitCommitHorizontal,
  Pause,
  Play,
  Plug,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import { actionService } from "@/services/ActionService";
import type { ComputedSubtitle, WorktreeReviewState } from "./hooks/useWorktreeStatus";
import {
  SECTION_LABEL,
  CARD_DENSITY,
  DISCLOSURE_BUTTON,
  DISCLOSURE_BUTTON_LABELLED,
} from "./sectionChrome";
import { useCardFocusHandoff } from "./hooks/useCardFocusHandoff";
import { resourceLifecycleVisibility } from "../utils/resourceLifecycle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { pluralize } from "@/lib/pluralize";

const COUNT_BUMP_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

const LazyLifecycleCommandApprovalDialog = lazy(() =>
  import("../LifecycleCommandApprovalDialog").then((m) => ({
    default: m.LifecycleCommandApprovalDialog,
  }))
);

export interface WorktreeDetailsSectionProps {
  worktree: WorktreeState;
  homeDir?: string;
  /**
   * Which density this card is drawn at — see `CARD_DENSITY` in
   * `./sectionChrome`. Both variants are now the same construction: a flat
   * summary row on the card surface, and one well when the section is opened.
   *
   * The grid used to keep a bordered, filled well in both states. That was
   * defensible while the reasoning was "the sidebar row is already a
   * container, the grid card is not" — but the grid card IS a container, and
   * a second bordered plane inside it (with a third for the note and a fourth
   * for the file list) is the card-in-card that Carbon and Material 3 both
   * name as the failure mode for this component.
   *
   * Bordered is the operative word. The changed-files list inside Details does
   * carry a fill of its own (#12102) and does not reopen this: it draws no
   * perimeter, so it reads as a section of the well rather than a plane
   * stacked on top of it.
   */
  variant?: "sidebar" | "grid";
  isExpanded: boolean;
  hasChanges: boolean;
  computedSubtitle: ComputedSubtitle;
  reviewState?: WorktreeReviewState;
  effectiveNote?: string;
  effectiveSummary?: string | null;
  worktreeErrors: ErrorRecord[];
  isFocused: boolean;
  isStale?: boolean;
  /** Names the worktree in the disclosure's accessible name. */
  worktreeLabel?: string;
  onToggleExpand: (e: React.MouseEvent) => void;
  onPathClick: () => void;
  onDismissError: (id: string) => void;
  onRetryError: (id: string, action: RetryAction, args?: Record<string, unknown>) => Promise<void>;
  onOpenReviewHub?: () => void;
  /**
   * Set when the presentation profile quiets git detail (#13777): the branch,
   * issue, PR and sync detail the header stopped drawing, shown at the top of
   * the expanded panel. The resting row drops its last-activity chip, whose
   * time and commit the panel's own last-active line already carries, and the
   * Review Hub shortcut leaves the resting row for the menu's Git submenu
   * unless the worktree is conflicted, where it is the way out.
   */
  quietGitDetail?: React.ReactNode;
  /** The sync line, when the card itself leaves it to Details (sidebar, default profile). */
  syncDetail?: React.ReactNode;
  isLifecycleRunning?: boolean;
  lifecycleLabel?: string;

  isBeingDeleted?: boolean;
  deleteError?: string | null;

  hasResourceConfig?: boolean;
  resourceStatus?: string;
  onResourceResume?: () => void;
  onResourcePause?: () => void;
  onResourceConnect?: () => void;
  onResourceProvision?: () => void;
  onResourceTeardown?: () => void;
  onResourceStatus?: () => void;
}

export function WorktreeDetailsSection(props: WorktreeDetailsSectionProps) {
  const {
    worktree,
    homeDir,
    variant = "sidebar",
    isExpanded,
    hasChanges,
    computedSubtitle,
    effectiveNote,
    effectiveSummary,
    worktreeErrors,
    isFocused,
    isStale,
    worktreeLabel,
    onToggleExpand,
    onPathClick,
    onDismissError,
    onRetryError,
    onOpenReviewHub,
    quietGitDetail,
    syncDetail,
    reviewState,
    isLifecycleRunning,
    lifecycleLabel,
    isBeingDeleted,
    deleteError,

    hasResourceConfig,
    resourceStatus,
    onResourceResume,
    onResourcePause,
    onResourceConnect,
    onResourceTeardown,
    onResourceStatus,
  } = props;
  const detailsId = `worktree-${worktree.id}-details`;
  const detailsPanelId = `worktree-${worktree.id}-details-panel`;

  // Forge-resolved committer avatar (#8514). Resolves to the provider's
  // profile picture when the email is public; `undefined` while loading or on
  // miss, so the existing Gravatar tier transparently takes over.
  const forgeAuthorAvatarUrl = useForgeAuthorAvatar({
    email: worktree.worktreeChanges?.lastCommitAuthor?.email,
    cwd: worktree.path,
  });

  const reviewChangeLine = useReviewChangeHint(worktree);
  const changedFileCount = worktree.worktreeChanges?.changedFileCount ?? 0;
  const countRef = useRef<HTMLSpanElement>(null);
  const prefersReducedMotion = useShouldSkipMotion();
  const didMountRef = useRef(false);
  const prevCountRef = useRef(changedFileCount);
  const lastBumpTimeRef = useRef(0);

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (changedFileCount === prevCountRef.current) return;
    prevCountRef.current = changedFileCount;

    if (prefersReducedMotion) return;
    const countEl = countRef.current;
    if (countEl == null) return;
    if (
      document.body.dataset.performanceMode === "true" ||
      Date.now() - lastBumpTimeRef.current < DURATION_200
    )
      return;

    lastBumpTimeRef.current = Date.now();
    // Native WAAPI rather than framer-motion's useAnimate, which dragged its
    // imperative animate/sequence runtime into the eager motion chunk. The
    // easing sits on each keyframe so it applies per segment, as framer's
    // single `ease` did across keyframes.
    countEl.animate(
      [
        { transform: "scale(1)", easing: COUNT_BUMP_EASING },
        { transform: "scale(1.06)", easing: COUNT_BUMP_EASING },
        { transform: "scale(1)" },
      ],
      { duration: DURATION_200 }
    );
  }, [changedFileCount, prefersReducedMotion]);

  const isConflicted = reviewState === "conflicted";

  // The resting row's words truncate on whichever inner span holds them, so
  // the summary measures on hover and reveals the full text only when
  // something was cut. A keyboard user hears it as the disclosure's
  // description instead.
  const [summaryReveal, setSummaryReveal] = useState<string | null>(null);
  const measureSummary = (el: HTMLElement) => {
    const cut = [el, ...el.querySelectorAll<HTMLElement>(".truncate")].some(
      (node) => node.scrollWidth > node.clientWidth + 1
    );
    setSummaryReveal(cut ? el.textContent?.trim() || null : null);
  };
  // A clean tree with unpushed commits still has a Review Hub next step —
  // push — so the opener stays visible; only the label shifts to match.
  const isUnpushedClean = reviewState === "unpushed-clean" && !hasChanges;
  const showReviewHubButton =
    !!onOpenReviewHub &&
    (hasChanges || isUnpushedClean) &&
    (quietGitDetail === undefined || isConflicted);
  const reviewHubButtonLabel = isUnpushedClean ? "Review & push" : "Review & commit";

  const lifecycleState = worktree.lifecycleStatus?.state;
  const lifecycleSlotFailed = lifecycleState === "failed" || lifecycleState === "timed-out";
  // Plugin steps that did not succeed stay retryable after a later resource
  // action overwrites the lifecycle slot, so their failure is read from
  // `setupStatus`, which no later phase repurposes.
  const pluginStepsFailed =
    !lifecycleSlotFailed &&
    lifecycleState !== "running" &&
    worktree.setupStatus?.stage === "plugin-steps" &&
    (worktree.setupStatus.state === "failed" || worktree.setupStatus.state === "timed-out");
  // Setup still running refuses a retry, whatever an overwritten slot says.
  const lifecycleFailed =
    worktree.setupStatus?.state !== "running" && (lifecycleSlotFailed || pluginStepsFailed);
  const lifecycleError = pluginStepsFailed
    ? worktree.setupStatus?.error
    : worktree.lifecycleStatus?.error;
  const lifecycleOutput = pluginStepsFailed ? undefined : worktree.lifecycleStatus?.output;
  const hasLifecycleDetails = lifecycleFailed && Boolean(lifecycleError || lifecycleOutput);
  // Two separate observations: the host found unapproved repository commands
  // this worktree would run, and/or its setup was skipped for want of approval.
  // The second outlives the first once the commands are approved elsewhere.
  const commandsNeedApproval = worktree.lifecycleCommandsNeedApproval === true;
  // `setupStatus` first: `lifecycleStatus` is one slot every later resource
  // action overwrites, so a status check would otherwise erase the only way
  // back to a setup that never ran. The lifecycle read covers a setup skipped
  // outside the create tail (an environment switch), which has no setup status.
  const setupNeedsApproval =
    worktree.setupStatus?.state === "needs-approval" ||
    (worktree.lifecycleStatus?.phase === "setup" && lifecycleState === "needs-approval");
  // The setup script ran; what waits is a plugin's step, not repository commands.
  const pluginStepsNeedApproval =
    worktree.setupStatus?.state === "needs-approval" &&
    worktree.setupStatus.stage === "plugin-steps";
  const [isApprovalDialogOpen, setIsApprovalDialogOpen] = useState(false);
  const approvalDialogMounted = useKeepMounted(isApprovalDialogOpen);
  const handleReviewCommands = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsApprovalDialogOpen(true);
  };
  const [isRetryingSetup, setIsRetryingSetup] = useState(false);
  const handleRetrySetup = async (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    if (isRetryingSetup) return;
    setIsRetryingSetup(true);
    try {
      // Pin the action context to this card's worktree so `isEnabled` evaluates
      // against the failed card, not whichever worktree happens to be focused.
      await actionService.dispatch(
        "worktree.lifecycle.retrySetup",
        { worktreeId: worktree.id },
        { source: "user", contextOverride: { focusedWorktreeId: worktree.id } }
      );
    } finally {
      setIsRetryingSetup(false);
    }
  };

  // Same rule the worktree menu's Runtime ▸ Environment section applies, so the
  // inline controls and the menu can never disagree about whether this
  // environment is resumable or pausable.
  const lifecycle = resourceLifecycleVisibility(resourceStatus);
  const showResourceResume = hasResourceConfig && lifecycle.showResume;
  const showResourcePause = hasResourceConfig && lifecycle.showPause;
  const showResourceConnect = hasResourceConfig && !!onResourceConnect && lifecycle.showConnect;

  const isSidebar = variant === "sidebar";
  const density = CARD_DENSITY[isSidebar ? "sidebar" : "grid"];
  const detailsLabel = worktreeLabel ? `Details for worktree ${worktreeLabel}` : "Details";

  return (
    <>
      <div
        id={detailsId}
        className={cn(
          // Both variants now: expanded Details is a well, exactly like
          // sessions below it — once it has a body of its own to hold, it
          // needs the contour that says the body belongs to it. Collapsed it
          // is a single row, and a well around one row is a box around
          // nothing.
          //
          // The grid used to keep the well in BOTH states, plus a rule under
          // its own trigger. Stacked against the sessions well directly below
          // it, that gave the card two identical bordered boxes and nothing
          // saying which was git state and which was running work. The card is
          // already the container; one closed contour inside it is the budget.
          isExpanded ? density.well : isSidebar && "border border-transparent",
          // The summary row must not move when it is clicked. The well brings
          // its own top margin (6px sidebar, 8px grid) and, in the sidebar, a
          // 1px border, so opening the section used to drop the line 3px in
          // the sidebar and 2px in the grid — a visible twitch on the one
          // element the click is aimed at.
          //
          // So the margin is pinned to the collapsed value in both states
          // (it wins over the well's via `cn`'s tailwind-merge), and the
          // border is reserved as transparent when it isn't drawn. Collapsed
          // is the value to keep: the metadata cluster above is spaced
          // against this row's 4px specifically — see the body padding note in
          // `WorktreeCard.tsx`. Reserving the border also puts the collapsed
          // row's text on the same x as the sessions row below it, which
          // always sits inside a well.
          isSidebar ? "mt-1" : "mt-1.5"
        )}
      >
        {/* One row in both states, and its leading chevron is the only part of
            it that toggles: the summary, the commit line and the padding are
            the card's content and select the worktree like the rest of it
            (#15864). The row used to be the trigger end to end, so a click
            aimed at the worktree opened a disclosure instead. */}
        <div className={cn("flex min-w-0 items-center text-left", density.rowBox)}>
          <button
            type="button"
            onClick={onToggleExpand}
            aria-expanded={isExpanded}
            aria-controls={detailsPanelId}
            aria-label={detailsLabel}
            // The row's own words, so the disclosure names what it
            // summarises rather than only that it opens.
            aria-describedby={isExpanded ? undefined : `${detailsId}-summary`}
            id={`${detailsId}-button`}
            className={cn(DISCLOSURE_BUTTON, isExpanded && DISCLOSURE_BUTTON_LABELLED)}
          >
            <ChevronRight
              className={cn("h-3 w-3 shrink-0 text-text-secondary", isExpanded && "rotate-90")}
              aria-hidden="true"
            />
            {isExpanded &&
              (isBeingDeleted && !deleteError ? (
                <span className={SECTION_LABEL} role="status" aria-live="polite">
                  <span className="flex items-center gap-1.5">
                    <Spinner size="xs" className="shrink-0" />
                    <span>Deleting…</span>
                  </span>
                </span>
              ) : (
                <span className={SECTION_LABEL}>Details</span>
              ))}
          </button>
          {!isExpanded && (
            <>
              <TruncatedTooltip
                content={summaryReveal}
                isTruncated={summaryReveal !== null}
                side="bottom"
                contentClassName="max-w-xs [overflow-wrap:anywhere]"
                focusable={false}
              >
                <span
                  id={`${detailsId}-summary`}
                  onPointerEnter={(event) => measureSummary(event.currentTarget)}
                  className="text-xs truncate min-w-0 flex-1"
                >
                  {isBeingDeleted && !deleteError ? (
                    <span
                      className="flex items-center gap-1.5 text-text-secondary"
                      role="status"
                      aria-live="polite"
                    >
                      <Spinner size="xs" className="shrink-0" />
                      <span className="truncate">Deleting…</span>
                    </span>
                  ) : isLifecycleRunning && lifecycleLabel ? (
                    <span className="flex items-center gap-1.5 text-text-secondary">
                      <span
                        aria-hidden="true"
                        className="status-mark inline-block w-2 h-2 rounded-full bg-text-secondary animate-pulse-immediate shrink-0"
                      />
                      <span className="truncate">{lifecycleLabel}</span>
                    </span>
                  ) : lifecycleLabel &&
                    !isLifecycleRunning &&
                    worktree.lifecycleStatus?.state !== "success" ? (
                    // Neutral words, hue on the severity glyph: status hues
                    // miss 4.5:1 as text on several themes.
                    <span className="flex items-center gap-1.5 text-text-secondary">
                      {lifecycleState === "needs-approval" ? (
                        <SEVERITY_GLYPH.warning
                          className="w-3 h-3 shrink-0 text-status-warning"
                          aria-hidden="true"
                        />
                      ) : (
                        <SEVERITY_GLYPH.error
                          className="w-3 h-3 shrink-0 text-status-error"
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate">{lifecycleLabel}</span>
                    </span>
                  ) : isConflicted ? (
                    <span className="flex items-center gap-1.5 text-text-secondary">
                      <SEVERITY_GLYPH.error
                        className="w-3 h-3 shrink-0 text-status-error"
                        aria-hidden="true"
                      />
                      <span className="truncate">Conflicts need review</span>
                    </span>
                  ) : hasChanges && worktree.worktreeChanges ? (
                    <span className="flex items-center gap-1.5 text-text-secondary">
                      <span ref={countRef} className="inline-block">
                        {pluralize(worktree.worktreeChanges.changedFileCount, "file")}
                      </span>
                      {/* Clipped mid-digit it misreads (+214 became "+2"), so on a
                          narrow sidebar card it gives way whole and the file
                          count stands alone; Details lists every file. */}
                      <span
                        className={cn("inline-flex", isSidebar && "hidden @xs/card:inline-flex")}
                      >
                        <DiffStat
                          insertions={worktree.worktreeChanges.insertions}
                          deletions={worktree.worktreeChanges.deletions}
                        />
                      </span>
                      {reviewChangeLine && (
                        <span className="truncate text-text-secondary">· {reviewChangeLine}</span>
                      )}
                    </span>
                  ) : (
                    // Secondary words whatever the tone, with the hue on a
                    // severity glyph: status hues and text-muted both miss
                    // 4.5:1 as text on several themes.
                    <span
                      className={cn(
                        "text-text-secondary",
                        (reviewChangeLine ||
                          computedSubtitle.tone === "warning" ||
                          computedSubtitle.tone === "info") &&
                          "flex items-center gap-1.5"
                      )}
                    >
                      {computedSubtitle.tone === "warning" && (
                        <SEVERITY_GLYPH.warning
                          className="w-3 h-3 shrink-0 text-status-warning"
                          aria-hidden="true"
                        />
                      )}
                      {computedSubtitle.tone === "info" && (
                        <SEVERITY_GLYPH.info
                          className="w-3 h-3 shrink-0 text-status-info"
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate">{computedSubtitle.text}</span>
                      {reviewChangeLine && (
                        <span className="truncate text-text-secondary">· {reviewChangeLine}</span>
                      )}
                    </span>
                  )}
                </span>
              </TruncatedTooltip>

              {hasResourceConfig && (
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <span className="sr-only">Resource actions</span>
                  </ContextMenuTrigger>
                  <ContextMenuContent onClick={(e) => e.stopPropagation()}>
                    {showResourceResume && onResourceResume && (
                      <ContextMenuItem onClick={onResourceResume}>
                        <Play className="w-3.5 h-3.5 mr-2" />
                        Resume resource
                      </ContextMenuItem>
                    )}
                    {showResourcePause && onResourcePause && (
                      <ContextMenuItem onClick={onResourcePause}>
                        <Pause className="w-3.5 h-3.5 mr-2" />
                        Pause resource
                      </ContextMenuItem>
                    )}
                    {showResourceConnect && (
                      <ContextMenuItem onClick={onResourceConnect}>
                        <Plug className="w-3.5 h-3.5 mr-2" />
                        Connect to resource
                      </ContextMenuItem>
                    )}
                    {(showResourceResume || showResourcePause || showResourceConnect) &&
                      onResourceStatus && <ContextMenuSeparator />}
                    {onResourceStatus && (
                      <ContextMenuItem onClick={onResourceStatus}>
                        <Activity className="w-3.5 h-3.5 mr-2" />
                        Check status
                      </ContextMenuItem>
                    )}
                    {onResourceTeardown && (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem destructive onClick={onResourceTeardown}>
                          <Trash2 className="w-3.5 h-3.5 mr-2" />
                          Tear down resource
                        </ContextMenuItem>
                      </>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              )}

              {hasResourceConfig &&
                (showResourceResume || showResourcePause || showResourceConnect) && (
                  <span className="relative z-10 ml-1 inline-flex shrink-0 items-center gap-0.5">
                    {showResourceResume && onResourceResume && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              onResourceResume();
                            }}
                            className="shrink-0"
                            aria-label="Resume resource"
                          >
                            <Play />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Resume resource</TooltipContent>
                      </Tooltip>
                    )}
                    {showResourcePause && onResourcePause && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              onResourcePause();
                            }}
                            className="shrink-0"
                            aria-label="Pause resource"
                          >
                            <Pause />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Pause resource</TooltipContent>
                      </Tooltip>
                    )}
                    {showResourceConnect && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost-info"
                            size="icon-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              onResourceConnect!();
                            }}
                            className="shrink-0"
                            aria-label="Connect to resource"
                          >
                            <Plug />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Connect to resource</TooltipContent>
                      </Tooltip>
                    )}
                  </span>
                )}

              {/* Before the age, so every card's age ends on the same right
                    edge whether or not it has something to review. */}
              {showReviewHubButton && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={(event) => {
                        // A control, so the card ignores it anyway; the stop
                        // keeps the section honest wherever it is rendered.
                        event.stopPropagation();
                        onOpenReviewHub?.();
                      }}
                      onPointerEnter={() => void prefetchStagingStatus(worktree.path)}
                      className={cn(
                        // Neutral, like the row's other controls: in the
                        // working hue it read as one more status mark, green
                        // beside a merge conflict.
                        "relative z-10 shrink-0 transition-colors",
                        "text-text-secondary hover:bg-overlay-soft hover:text-text-primary",
                        // Both variants: a trailing icon button in the same
                        // row. The fenced right segment the grid used to draw
                        // — a left border plus a right-rounded cap — made one
                        // summary read as a split pill whose second half was
                        // an unlabelled glyph nobody could name.
                        //
                        // `min-h-6 min-w-6` is the 24px target floor
                        // (WCAG 2.2 SC 2.5.8): a 14px glyph in `px-1.5 py-1`
                        // is 26x22, which fails on the short axis.
                        // -my-1 lets the 24px target overlap the row's own padding, so
                        // a card with something to review is no taller than one without.
                        "-my-1 mr-0.5 flex min-h-6 min-w-6 items-center justify-center rounded-[var(--radius-md)] px-1.5",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]"
                      )}
                      aria-label={`Open ${reviewHubButtonLabel}`}
                    >
                      <GitCommitHorizontal className="w-3.5 h-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{reviewHubButtonLabel}</TooltipContent>
                </Tooltip>
              )}
              {quietGitDetail === undefined && (
                <WorktreeActivityChip
                  lastCommitTimestampMs={worktree.worktreeChanges?.lastCommitTimestampMs}
                  author={worktree.worktreeChanges?.lastCommitAuthor}
                  commitMessage={worktree.worktreeChanges?.lastCommitMessage}
                  commitBody={worktree.worktreeChanges?.lastCommitBody}
                  commitSha={worktree.worktreeChanges?.headOid}
                  forgeAvatarUrl={forgeAuthorAvatarUrl}
                  lastActivityTimestamp={worktree.lastActivityTimestamp}
                />
              )}
            </>
          )}
        </div>
        {isExpanded && (
          <div
            id={detailsPanelId}
            role="region"
            aria-labelledby={`${detailsId}-button`}
            // Inside the well now, so it owns the well's padding. The
            // trigger above it supplies the top inset.
            className={cn(
              isSidebar
                ? "px-2.5 pb-2"
                : // The grid caps the opened panel and scrolls inside it.
                  // Grid rows share a height, so an unbounded panel is not
                  // only this card's problem: one card expanded to 460px
                  // took its three row-mates with it and left 250px of
                  // nothing in each. Bounding it is the standard correction
                  // for variable-height cards in a grid, and 208px still
                  // shows the note plus the first several changed files.
                  //
                  // It does not fully solve the row: `items-stretch` still
                  // propagates whatever height the open card ends up with,
                  // so its row-mates grow with it. Moving Details out of
                  // flow entirely — a side inspector or an anchored overlay
                  // — is the only thing that would, and that is a change to
                  // what the disclosure IS rather than to how it looks.
                  "max-h-52 overflow-y-auto px-3 pb-2.5"
            )}
          >
            {quietGitDetail}
            {syncDetail}
            <WorktreeDetails
              variant={variant}
              worktree={worktree}
              homeDir={homeDir}
              effectiveNote={effectiveNote}
              effectiveSummary={effectiveSummary}
              worktreeErrors={worktreeErrors}
              hasChanges={hasChanges}
              isFocused={isFocused}
              isStale={isStale}
              onPathClick={onPathClick}
              onDismissError={onDismissError}
              onRetryError={onRetryError}
              showLastCommit={true}
              lastActivityTimestamp={worktree.lastActivityTimestamp}
              showTime={true}
              forgeAvatarUrl={forgeAuthorAvatarUrl}
            />
          </div>
        )}

        {lifecycleFailed && (
          <div
            // Recovery block: pressing in it never switches worktrees.
            data-card-control=""
            className={cn(
              // No rule above it in either variant: this block follows
              // the summary row on the card's own surface, and a full-width
              // hairline there reads as another section boundary rather than
              // as this row's own continuation.
              "flex flex-col gap-2 py-1",
              // Outside the Details disclosure, like the approval block below:
              // opening Details to look into a failed setup must not take
              // away the way to re-run it.
              isExpanded
                ? isSidebar
                  ? "px-2.5"
                  : "px-3"
                : isSidebar
                  ? "mt-1"
                  : "mt-1 pl-1.5 pr-2.5"
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 text-xs text-text-secondary">
                Setup didn't finish. Re-run when you're ready.
              </span>
              <Button
                variant="outline"
                size="xs"
                onClick={handleRetrySetup}
                loading={isRetryingSetup}
                className="shrink-0 shadow-none inset-shadow-none"
              >
                <RefreshCw aria-hidden="true" />
                Retry setup
              </Button>
            </div>
            {hasLifecycleDetails && (
              <details className="group/setup-log text-xs">
                {/* Its own control: a click opens the log, never also selects
                    the card underneath. */}
                <summary
                  onClick={(e) => e.stopPropagation()}
                  className="flex min-h-6 items-center gap-1 rounded-[var(--radius-xs)] text-text-secondary cursor-pointer select-none transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
                >
                  {/* The card's own disclosure grammar: a right chevron that
                      turns down when open. A static down chevron claimed the
                      log was showing before it was. */}
                  <ChevronRight
                    className="w-3 h-3 transition-transform duration-150 group-open/setup-log:rotate-90 motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                  Output
                </summary>
                <pre className="mt-1.5 max-h-32 overflow-auto rounded-[var(--radius-md)] bg-status-error/5 p-2 font-mono text-2xs text-text-secondary whitespace-pre-wrap break-all select-text">
                  {[lifecycleError, lifecycleOutput].filter(Boolean).join("\n\n")}
                </pre>
              </details>
            )}
          </div>
        )}

        {(commandsNeedApproval || setupNeedsApproval) && (
          <div
            className={cn(
              "flex items-center justify-between gap-2 py-1",
              // Outside the Details disclosure on purpose: whether it is open
              // must not decide whether an approval request can be seen.
              isExpanded
                ? isSidebar
                  ? "px-2.5"
                  : "px-3"
                : isSidebar
                  ? "mt-1"
                  : "mt-1 pl-1.5 pr-2.5"
            )}
            data-testid="worktree-command-approval"
            data-card-control=""
          >
            <span className="text-xs text-text-secondary truncate">
              {commandsNeedApproval
                ? pluginStepsNeedApproval
                  ? "Setup is waiting for you to allow plugin steps"
                  : setupNeedsApproval
                    ? "Setup is waiting for you to approve its commands"
                    : "Repository commands need your approval to run"
                : "Setup was skipped, and its commands are approved now"}
            </span>
            <Button
              variant="outline"
              size="xs"
              onClick={commandsNeedApproval ? handleReviewCommands : handleRetrySetup}
              loading={!commandsNeedApproval && isRetryingSetup}
              disabled={!commandsNeedApproval && lifecycleState === "running"}
              className="shrink-0 shadow-none inset-shadow-none"
            >
              {commandsNeedApproval ? (
                // The row's own signal: an approval is waiting on the user.
                <ShieldAlert className="text-status-warning" aria-hidden="true" />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              {commandsNeedApproval
                ? pluginStepsNeedApproval
                  ? "Review steps"
                  : "Review commands"
                : "Run setup"}
            </Button>
          </div>
        )}
      </div>

      {approvalDialogMounted && (
        <Suspense fallback={null}>
          <LazyLifecycleCommandApprovalDialog
            isOpen={isApprovalDialogOpen}
            worktreeId={worktree.id}
            setupAwaitingApproval={setupNeedsApproval}
            onClose={() => setIsApprovalDialogOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}

export interface WorktreeDeleteErrorBannerProps {
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}

/**
 * Stand-alone banner so the card can render it outside of the details section
 * (which is hidden when the card is collapsed). The user must be able to see
 * a delete failure regardless of collapse state — otherwise a collapsed card
 * silently absorbs the error.
 */
export function WorktreeDeleteErrorBanner({
  message,
  onRetry,
  onDismiss,
}: WorktreeDeleteErrorBannerProps) {
  // The card ignores clicks on its controls (`cardClickTarget.ts`); the stop
  // is kept so dismissing an error on a background card can never switch the
  // active worktree even where this banner is rendered outside one (#12087).
  const handleRetryClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRetry?.();
  };
  const handleDismissClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDismiss?.();
  };
  // Retry and Dismiss both clear the error, which unmounts this banner from
  // under the button that was pressed.
  const focusHandoffRef = useCardFocusHandoff<HTMLDivElement>();
  return (
    <Callout
      severity="error"
      ref={focusHandoffRef}
      role="alert"
      aria-live="assertive"
      data-testid="worktree-delete-error-banner"
      title="Couldn't delete worktree"
      // `relative z-10` is load-bearing, not decoration. Both banners mount as
      // bare siblings of the card's `relative z-10` content column, inside a
      // `relative isolate` root that also carries the sidebar's full-card select
      // overlay at `absolute inset-0 z-0`. A static block paints in an earlier
      // step than a positioned `z-0` sibling regardless of DOM order, so without
      // this the overlay covered the banner and swallowed every click on Retry
      // and Dismiss (#12087). Joins the tier the content column already uses.
      className="relative z-10 mt-2"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          {/* Git stderr is multi-line and the lines after the first are the
              ones that say how to recover, so the breaks have to survive. The
              height cap keeps an unbounded message from pushing Retry and
              Dismiss off a compact card — it scrolls, nothing is cut. */}
          <span
            tabIndex={0}
            className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-text-secondary select-text"
          >
            {message}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onRetry && (
            <Button
              variant="outline"
              size="xs"
              onClick={handleRetryClick}
              data-testid="worktree-delete-retry"
              className="shadow-none inset-shadow-none"
            >
              Retry
            </Button>
          )}
          {onDismiss && (
            <Button
              variant="ghost"
              size="xs"
              onClick={handleDismissClick}
              data-testid="worktree-delete-dismiss"
            >
              Dismiss
            </Button>
          )}
        </div>
      </div>
    </Callout>
  );
}

export interface WorktreeIssueErrorBannerProps {
  message: string;
  /** Drives the title — attach vs detach failure (#9163). */
  mutationType: "attach-issue" | "detach-issue";
  onRetry?: () => void;
  onDismiss?: () => void;
}

/**
 * Inline banner for a failed attach/detach-issue mutation (#9163), mirroring
 * {@link WorktreeDeleteErrorBanner}. Rendered outside the details section so a
 * collapsed card still surfaces the failure rather than silently absorbing it.
 */
export function WorktreeIssueErrorBanner({
  message,
  mutationType,
  onRetry,
  onDismiss,
}: WorktreeIssueErrorBannerProps) {
  const title = mutationType === "attach-issue" ? "Couldn't attach issue" : "Couldn't unlink issue";
  // The card ignores clicks on its controls (`cardClickTarget.ts`); the stop
  // is kept so dismissing an error on a background card can never switch the
  // active worktree even where this banner is rendered outside one (#12087).
  const handleRetryClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRetry?.();
  };
  const handleDismissClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDismiss?.();
  };
  // Retry and Dismiss both drop the outbox entry, which unmounts this banner
  // from under the button that was pressed.
  const focusHandoffRef = useCardFocusHandoff<HTMLDivElement>();
  return (
    <Callout
      severity="error"
      ref={focusHandoffRef}
      role="alert"
      aria-live="assertive"
      data-testid="worktree-issue-error-banner"
      title={title}
      // `relative z-10` is load-bearing, not decoration. Both banners mount as
      // bare siblings of the card's `relative z-10` content column, inside a
      // `relative isolate` root that also carries the sidebar's full-card select
      // overlay at `absolute inset-0 z-0`. A static block paints in an earlier
      // step than a positioned `z-0` sibling regardless of DOM order, so without
      // this the overlay covered the banner and swallowed every click on Retry
      // and Dismiss (#12087). Joins the tier the content column already uses.
      className="relative z-10 mt-2"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="break-words text-text-secondary">{message}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onRetry && (
            <Button
              variant="outline"
              size="xs"
              onClick={handleRetryClick}
              data-testid="worktree-issue-retry"
              className="shadow-none inset-shadow-none"
            >
              Retry
            </Button>
          )}
          {onDismiss && (
            <Button
              variant="ghost"
              size="xs"
              onClick={handleDismissClick}
              data-testid="worktree-issue-dismiss"
            >
              Dismiss
            </Button>
          )}
        </div>
      </div>
    </Callout>
  );
}
