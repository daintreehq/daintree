import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { WorktreeState } from "@/types";
import type { RetryAction } from "@/store";
import type { ErrorRecord } from "@/store/errorStore";
import { useAnimate, useReducedMotion } from "framer-motion";
import { DURATION_200 } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { WorktreeDetails } from "../WorktreeDetails";
import { WorktreeActivityChip } from "./WorktreeActivityChip";
import { Spinner } from "@/components/ui/Spinner";
import { useForgeAuthorAvatar } from "@/hooks/useForgeAuthorAvatar";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  GitCommitHorizontal,
  Plug,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { actionService } from "@/services/ActionService";
import type { ComputedSubtitle, WorktreeReviewState } from "./hooks/useWorktreeStatus";
import { SECTION_LABEL, CARD_DENSITY } from "./sectionChrome";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";

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
  onToggleExpand: (e: React.MouseEvent) => void;
  onPathClick: () => void;
  onDismissError: (id: string) => void;
  onRetryError: (id: string, action: RetryAction, args?: Record<string, unknown>) => Promise<void>;
  onOpenReviewHub?: () => void;
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
    onToggleExpand,
    onPathClick,
    onDismissError,
    onRetryError,
    onOpenReviewHub,
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

  const changedFileCount = worktree.worktreeChanges?.changedFileCount ?? 0;
  const [countScope, animate] = useAnimate<HTMLSpanElement>();
  const prefersReducedMotion = useReducedMotion();
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
    if (countScope.current == null) return;
    if (
      document.body.dataset.performanceMode === "true" ||
      Date.now() - lastBumpTimeRef.current < DURATION_200
    )
      return;

    lastBumpTimeRef.current = Date.now();
    animate(
      countScope.current,
      { scale: [1, 1.06, 1] },
      { duration: DURATION_200 / 1000, ease: [0.4, 0, 0.2, 1] }
    );
  }, [changedFileCount, prefersReducedMotion, animate, countScope]);

  const isConflicted = reviewState === "conflicted";
  // A clean tree with unpushed commits still has a Review Hub next step —
  // push — so the opener stays visible; only the label shifts to match.
  const isUnpushedClean = reviewState === "unpushed-clean" && !hasChanges;
  const showReviewHubButton = !!onOpenReviewHub && (hasChanges || isUnpushedClean);
  const reviewHubButtonLabel = isUnpushedClean ? "Review & push" : "Review & commit";

  const lifecycleState = worktree.lifecycleStatus?.state;
  const lifecycleFailed = lifecycleState === "failed" || lifecycleState === "timed-out";
  const lifecycleError = worktree.lifecycleStatus?.error;
  const lifecycleOutput = worktree.lifecycleStatus?.output;
  const hasLifecycleDetails = lifecycleFailed && Boolean(lifecycleError || lifecycleOutput);
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

  const rsLower = resourceStatus?.toLowerCase();
  const showResourceResume =
    hasResourceConfig &&
    (!rsLower ||
      rsLower === "paused" ||
      rsLower === "stopped" ||
      rsLower === "unknown" ||
      rsLower === "terminated" ||
      rsLower === "down");
  const showResourcePause = hasResourceConfig && (rsLower === "running" || rsLower === "starting");
  const showResourceConnect = hasResourceConfig && !!onResourceConnect && rsLower === "running";

  const isSidebar = variant === "sidebar";
  const density = CARD_DENSITY[isSidebar ? "sidebar" : "grid"];

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
          isExpanded ? density.well : isSidebar ? "mt-1" : "mt-1.5"
        )}
      >
        {isExpanded ? (
          <div>
            <button
              onClick={onToggleExpand}
              aria-expanded={true}
              aria-controls={detailsPanelId}
              className={cn(
                // Leading chevron, no fill, no rule under it: the trigger has
                // to stay attached to the body it just revealed. A divider
                // there cuts the two apart and they read as separate
                // components.
                "transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]",
                density.row,
                "gap-1.5"
              )}
              id={`${detailsId}-button`}
            >
              <ChevronRight className="h-3 w-3 shrink-0 rotate-90 text-text-secondary" />
              {isBeingDeleted && !deleteError ? (
                <span className={SECTION_LABEL} role="status" aria-live="polite">
                  <span className="flex items-center gap-1.5">
                    <Spinner size="xs" className="shrink-0" />
                    <span>Deleting…</span>
                  </span>
                </span>
              ) : (
                <span className={SECTION_LABEL}>Details</span>
              )}
            </button>
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
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="flex items-stretch">
              <div
                onClick={onToggleExpand}
                className={cn(
                  "worktree-section-button relative flex min-w-0 flex-1 items-center justify-between text-left transition-colors",
                  // Sidebar: a flat row on the card surface with a hover
                  // backplate, not a permanent bordered well. Same hit area,
                  // same content, one less container.
                  // Shares the density's row box (it cannot use the row class
                  // itself — this row is a flex-1 sibling of the right button
                  // group, not a full-width row). The old -ml-1.5 chip put
                  // this line's chevron 16px left of the session row's
                  // directly beneath it.
                  //
                  // The grid used to spell this `px-3 py-2.5` inside a filled,
                  // bordered well, which put its text 9px left of the card
                  // title above it and gave a single line of metadata the
                  // weight of a container.
                  density.rowBox
                )}
              >
                <button
                  type="button"
                  aria-expanded={false}
                  aria-controls={detailsPanelId}
                  id={`${detailsId}-button`}
                  aria-label="Show details"
                  className={cn(
                    "absolute inset-0 rounded-[var(--radius-lg)]",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]"
                  )}
                />
                {/* The closed half of the same disclosure vocabulary the
                    expanded state uses. Flattening removed the well that used
                    to say "this is a thing you open", so without a chevron the
                    resting row is just a line of metadata. */}
                <ChevronRight
                  className="pointer-events-none relative z-10 mr-1.5 h-3 w-3 shrink-0 text-text-secondary"
                  aria-hidden="true"
                />
                <span className="relative z-10 text-xs truncate min-w-0 flex-1 pointer-events-none">
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
                    <span className="text-status-error">{lifecycleLabel}</span>
                  ) : isConflicted ? (
                    <span className="flex items-center gap-1.5 text-status-error">
                      <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">Conflicts need review</span>
                    </span>
                  ) : hasChanges && worktree.worktreeChanges ? (
                    <span className="flex items-center gap-1.5 text-text-secondary">
                      <span ref={countScope} className="inline-block">
                        {worktree.worktreeChanges.changedFileCount} file
                        {worktree.worktreeChanges.changedFileCount !== 1 ? "s" : ""}
                      </span>
                      {((worktree.worktreeChanges.insertions ?? 0) > 0 ||
                        (worktree.worktreeChanges.deletions ?? 0) > 0) && (
                        <span className="flex items-center gap-0.5">
                          {(worktree.worktreeChanges.insertions ?? 0) > 0 && (
                            <span className="text-status-success">
                              +{worktree.worktreeChanges.insertions}
                            </span>
                          )}
                          {(worktree.worktreeChanges.insertions ?? 0) > 0 &&
                            (worktree.worktreeChanges.deletions ?? 0) > 0 && (
                              <span className="text-text-muted">/</span>
                            )}
                          {(worktree.worktreeChanges.deletions ?? 0) > 0 && (
                            <span className="text-status-error">
                              -{worktree.worktreeChanges.deletions}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span
                      className={cn(
                        computedSubtitle.tone === "warning" && "text-status-warning",
                        computedSubtitle.tone === "info" && "text-status-info",
                        computedSubtitle.tone === "muted" && "text-text-muted"
                      )}
                    >
                      {computedSubtitle.text}
                    </span>
                  )}
                </span>

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
                          <Square className="w-3.5 h-3.5 mr-2" />
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
                          <ContextMenuItem
                            onClick={onResourceTeardown}
                            className="text-status-error"
                          >
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
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onResourceResume();
                              }}
                              className="flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-[var(--radius-md)] transition-colors text-status-success hover:bg-overlay-emphasis focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                              aria-label="Resume resource"
                            >
                              <Play className="w-3 h-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">Resume resource</TooltipContent>
                        </Tooltip>
                      )}
                      {showResourcePause && onResourcePause && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onResourcePause();
                              }}
                              className="flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-[var(--radius-md)] transition-colors text-status-error hover:bg-overlay-emphasis focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                              aria-label="Pause resource"
                            >
                              <Square className="w-3 h-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">Pause resource</TooltipContent>
                        </Tooltip>
                      )}
                      {showResourceConnect && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onResourceConnect!();
                              }}
                              className="flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-[var(--radius-md)] transition-colors text-status-info hover:bg-overlay-emphasis focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                              aria-label="Connect to resource"
                            >
                              <Plug className="w-3 h-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">Connect to resource</TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                  )}

                <WorktreeActivityChip
                  lastCommitTimestampMs={worktree.worktreeChanges?.lastCommitTimestampMs}
                  author={worktree.worktreeChanges?.lastCommitAuthor}
                  commitMessage={worktree.worktreeChanges?.lastCommitMessage}
                  forgeAvatarUrl={forgeAuthorAvatarUrl}
                  lastActivityTimestamp={worktree.lastActivityTimestamp}
                />
              </div>

              {showReviewHubButton && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={onOpenReviewHub}
                      className={cn(
                        "shrink-0 transition-colors",
                        "text-[var(--color-state-active)] hover:bg-[var(--color-state-active)]/10",
                        // Both variants: a trailing icon button in the same
                        // row. The fenced right segment the grid used to draw
                        // — a left border plus a right-rounded cap — made one
                        // summary read as a split pill whose second half was
                        // an unlabelled glyph nobody could name.
                        //
                        // `min-h-6 min-w-6` is the 24px target floor
                        // (WCAG 2.2 SC 2.5.8): a 14px glyph in `px-1.5 py-1`
                        // is 26x22, which fails on the short axis.
                        "ml-0.5 flex min-h-6 min-w-6 items-center justify-center rounded-[var(--radius-md)] px-1.5",
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
            </div>

            {lifecycleFailed && (
              <div
                className={cn(
                  // No rule above it in either variant: this block follows
                  // the collapsed summary row on the card's own surface, and
                  // a full-width hairline there reads as another section
                  // boundary rather than as this row's own continuation.
                  "flex flex-col gap-2 py-1",
                  isSidebar ? "mt-1" : "mt-1 pl-1.5 pr-2.5"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-text-muted truncate">
                    Setup didn't finish. Re-run when you're ready.
                  </span>
                  <button
                    type="button"
                    onClick={handleRetrySetup}
                    disabled={isRetryingSetup}
                    className={cn(
                      "shrink-0 inline-flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-1 text-xs font-medium transition-colors",
                      "text-status-error hover:bg-status-error/10",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]"
                    )}
                    aria-label="Retry setup"
                  >
                    <RotateCcw className="w-3 h-3" aria-hidden="true" />
                    {isRetryingSetup ? "Retrying…" : "Retry setup"}
                  </button>
                </div>
                {hasLifecycleDetails && (
                  <details className="text-xs">
                    <summary className="flex items-center gap-1 text-text-muted cursor-pointer select-none">
                      <ChevronDown className="w-3 h-3" aria-hidden="true" />
                      Show details
                    </summary>
                    <pre className="mt-1.5 max-h-32 overflow-auto rounded-[var(--radius-md)] bg-status-error/5 p-2 font-mono text-2xs text-text-secondary whitespace-pre-wrap break-all select-text">
                      {[lifecycleError, lifecycleOutput].filter(Boolean).join("\n\n")}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </div>
        )}
      </div>
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
  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="worktree-delete-error-banner"
      className="mt-2 flex items-start gap-2 rounded-[var(--radius-lg)] border border-status-error/20 bg-status-error/10 p-3 text-xs"
    >
      <AlertTriangle className="w-4 h-4 shrink-0 text-status-error" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-status-error">Couldn't delete worktree</span>
          <span className="break-words text-text-secondary">{message}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              data-testid="worktree-delete-retry"
              className="rounded-[var(--radius-md)] border border-status-error/30 px-2 py-1 text-status-error transition-colors hover:bg-status-error/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
            >
              Retry
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              data-testid="worktree-delete-dismiss"
              className="rounded-[var(--radius-md)] px-2 py-1 text-text-secondary transition-colors hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
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
  const title = mutationType === "attach-issue" ? "Couldn't attach issue" : "Couldn't detach issue";
  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="worktree-issue-error-banner"
      className="mt-2 flex items-start gap-2 rounded-[var(--radius-lg)] border border-status-error/20 bg-status-error/10 p-3 text-xs"
    >
      <AlertTriangle className="w-4 h-4 shrink-0 text-status-error" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-status-error">{title}</span>
          <span className="break-words text-text-secondary">{message}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              data-testid="worktree-issue-retry"
              className="rounded-[var(--radius-md)] border border-status-error/30 px-2 py-1 text-status-error transition-colors hover:bg-status-error/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
            >
              Retry
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              data-testid="worktree-issue-dismiss"
              className="rounded-[var(--radius-md)] px-2 py-1 text-text-secondary transition-colors hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
