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
import { SECTION_LABEL, SECTION_ROW, DISCLOSURE_WELL } from "./sectionChrome";
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
   * Sidebar cards flatten this section into the card surface; grid cards keep
   * the bordered, filled well. The sidebar row is already a container, and a
   * second bordered plane inside it (with a third for the note and a fourth
   * for the file list) reads as a stack of nested cards and eats ~34px of a
   * 240-360px column per level. The grid card sits on a wider, standalone
   * surface where the well still earns its keep.
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
  const rightButtonGroupShown = showReviewHubButton;

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

  return (
    <>
      <div
        id={detailsId}
        className={cn(
          isSidebar
            ? // Expanded Details is a well, exactly like sessions below it:
              // once it has a body of its own to hold, it needs the contour
              // that says the body belongs to it. Collapsed it is a single
              // row, and a well around one row is a box around nothing.
              isExpanded
              ? DISCLOSURE_WELL
              : "mt-2"
            : "mt-2 rounded-[var(--radius-lg)] border border-border-default bg-surface-inset p-3"
        )}
      >
        {isExpanded ? (
          <div className={cn(!isSidebar && "-m-3")}>
            <button
              onClick={onToggleExpand}
              aria-expanded={true}
              aria-controls={detailsPanelId}
              className={cn(
                "worktree-section-button flex w-full items-center text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]",
                isSidebar
                  ? // Leading chevron, no fill, no rule under it: the trigger has
                    // to stay attached to the body it just revealed. A divider
                    // there cuts the two apart and they read as separate
                    // components.
                    cn(SECTION_ROW, "gap-1.5")
                  : "justify-between rounded-t-[var(--radius-lg)] border-b border-border-default bg-surface-inset px-3 py-2.5"
              )}
              id={`${detailsId}-button`}
            >
              {isSidebar && <ChevronRight className="h-3 w-3 shrink-0 rotate-90 text-text-muted" />}
              {isBeingDeleted && !deleteError ? (
                <span
                  className={cn(
                    "flex items-center gap-1.5 text-xs font-medium text-text-secondary",
                    isSidebar && SECTION_LABEL
                  )}
                  role="status"
                  aria-live="polite"
                >
                  <Spinner size="xs" className="shrink-0" />
                  <span>Deleting…</span>
                </span>
              ) : (
                <span
                  className={cn(isSidebar ? SECTION_LABEL : "text-xs font-medium text-text-muted")}
                >
                  Details
                </span>
              )}
              {!isSidebar && <ChevronRight className="h-3 w-3 rotate-90 text-text-muted" />}
            </button>
            <div
              id={detailsPanelId}
              role="region"
              aria-labelledby={`${detailsId}-button`}
              // Inside the well now, so it owns the well's padding. The
              // trigger above it supplies the top inset.
              className={cn(isSidebar ? "px-2.5 pb-2" : "p-3")}
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
          <div className={cn("flex flex-col", !isSidebar && "-m-3")}>
            <div className="flex items-stretch">
              <div
                onClick={onToggleExpand}
                className={cn(
                  "worktree-section-button relative flex min-w-0 flex-1 items-center justify-between text-left transition-colors",
                  // Sidebar: a flat row on the card surface with a hover
                  // backplate, not a permanent bordered well. Same hit area,
                  // same content, one less container.
                  isSidebar
                    ? // Same geometry as SECTION_ROW (it cannot use the class
                      // itself — this row is a flex-1 sibling of the right
                      // button group, not a full-width row). The old -ml-1.5
                      // chip put this line's chevron 16px left of the session
                      // row's directly beneath it.
                      "rounded-[var(--radius-lg)] border border-transparent py-1.5 pl-1.5 pr-2.5"
                    : cn(
                        "px-3 py-2.5",
                        rightButtonGroupShown
                          ? "rounded-l-[var(--radius-lg)]"
                          : "rounded-[var(--radius-lg)]"
                      )
                )}
              >
                <button
                  type="button"
                  aria-expanded={false}
                  aria-controls={detailsPanelId}
                  id={`${detailsId}-button`}
                  aria-label="Show details"
                  className={cn(
                    "absolute inset-0",
                    isSidebar
                      ? "rounded-[var(--radius-lg)]"
                      : rightButtonGroupShown
                        ? "rounded-l-[var(--radius-lg)]"
                        : "rounded-[var(--radius-lg)]",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]"
                  )}
                />
                {isSidebar && (
                  // The closed half of the same disclosure vocabulary the
                  // expanded state uses. Flattening removed the well that used
                  // to say "this is a thing you open", so without a chevron the
                  // resting row is just a line of metadata.
                  <ChevronRight
                    className="pointer-events-none relative z-10 mr-1.5 h-3 w-3 shrink-0 text-text-muted"
                    aria-hidden="true"
                  />
                )}
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
                              className="shrink-0 p-1 rounded transition-colors text-status-success/70 hover:text-status-success hover:bg-overlay-emphasis focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
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
                              className="shrink-0 p-1 rounded transition-colors text-status-error/70 hover:text-status-error hover:bg-overlay-emphasis focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
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
                              className="shrink-0 p-1 rounded transition-colors text-status-info/70 hover:text-status-info hover:bg-overlay-emphasis focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
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
                        "text-[var(--color-state-active)]/70 hover:bg-[var(--color-state-active)]/10 hover:text-[var(--color-state-active)]",
                        // Sidebar: a trailing icon button in the same row. The
                        // fenced right segment made one summary read as a split
                        // pill with an unlabelled second half.
                        isSidebar
                          ? "ml-0.5 rounded-[var(--radius-md)] px-1.5 py-1"
                          : "rounded-r-[var(--radius-lg)] border-l border-border-default px-2 py-1",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]"
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
                  "flex flex-col gap-2",
                  isSidebar ? "mt-1 py-1" : "border-t border-border-default px-3 py-2"
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
                      "shrink-0 inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors",
                      "text-status-error hover:bg-status-error/10",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]"
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
                    <pre className="mt-1.5 max-h-32 overflow-auto rounded bg-status-error/5 p-2 font-mono text-[11px] text-text-secondary whitespace-pre-wrap break-all select-text">
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
              className="rounded border border-status-error/30 px-2 py-1 text-status-error transition-colors hover:bg-status-error/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
            >
              Retry
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              data-testid="worktree-delete-dismiss"
              className="rounded px-2 py-1 text-text-secondary transition-colors hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
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
              className="rounded border border-status-error/30 px-2 py-1 text-status-error transition-colors hover:bg-status-error/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
            >
              Retry
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              data-testid="worktree-issue-dismiss"
              className="rounded px-2 py-1 text-text-secondary transition-colors hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
