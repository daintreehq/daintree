import { useState, useCallback, useRef, useEffect, useId } from "react";
import { Callout } from "@/components/ui/Callout";
import type { PushProgressEvent } from "@shared/types/ipc/gitPush";
import type { GitPushDestination } from "@shared/types/git";
import { cn } from "@/lib/utils";
import { GitCommit, ArrowUpFromLine, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { KbdChord } from "@/components/ui/Kbd";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { isMac } from "@/lib/platform";
import { comboToAriaKeyshortcuts } from "@/lib/kbdShortcut";
import { REVIEW_HUB_DISABLED_CTA } from "./reviewHubUtils";
import { isProtectedBranch } from "@shared/utils/gitConstants";
import { RefChip } from "@/components/Git/GitOperationPreview";

const MAX_SUBJECT_LENGTH = 72;
const HISTORY_FETCH_POLL_INTERVAL_MS = 10;

// Shared by both primary CTAs so the panel shows one disabled treatment
// regardless of whether the worktree has a remote.
const DISABLED_CTA_CLASSES = cn(
  REVIEW_HUB_DISABLED_CTA,
  // Forced colours repaint every button ButtonText-on-ButtonFace, which made an
  // unavailable primary indistinguishable from a live one.
  "forced-colors:aria-disabled:text-[GrayText] forced-colors:aria-disabled:outline-[GrayText]"
);

const PRIMARY_SHORTCUT = "Cmd+Enter";
// How long a push can go without a progress event before the composer says so.
const PUSH_QUIET_MS = 15_000;

// simple-git reports the first word of git's progress line as the stage.
const PUSH_STAGE_LABELS: Record<string, string> = {
  enumerating: "Enumerating objects",
  counting: "Counting objects",
  compressing: "Compressing objects",
  writing: "Writing objects",
  receiving: "Receiving objects",
  resolving: "Resolving deltas",
  remote: "Remote",
};

function pushStageLabel(stage: string): string {
  const key = stage.replace(/:$/, "").toLowerCase();
  return PUSH_STAGE_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

function formatFileCount(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}

/**
 * Every unmet requirement in one sentence, most structural first, so fixing the
 * named one never uncovers a second the user was not told about.
 */
function describeBlockers({
  isDetachedHead,
  hasConflicts,
  needsStaging,
  needsMessage,
  stagedSummary,
}: {
  isDetachedHead: boolean;
  hasConflicts: boolean;
  needsStaging: boolean;
  needsMessage: boolean;
  stagedSummary: string;
}): string {
  const steps = [
    isDetachedHead && "switch to a branch",
    hasConflicts && "resolve merge conflicts",
    needsStaging && "stage files",
    needsMessage && "write a commit message",
  ].filter((step): step is string => typeof step === "string");
  const joined =
    steps.length > 1 ? `${steps.slice(0, -1).join(", ")} and ${steps[steps.length - 1]}` : steps[0];
  if (!joined) return "";
  if (isDetachedHead) return `Detached HEAD — ${joined} to commit`;
  const sentence = joined.charAt(0).toUpperCase() + joined.slice(1);
  // With files staged and nothing structural in the way, the count confirms what
  // the message will cover.
  return !needsStaging && !hasConflicts
    ? `${sentence} · ${stagedSummary}`
    : `${sentence} to commit`;
}

interface CommitPanelProps {
  stagedCount: number;
  isDetachedHead: boolean;
  hasConflicts: boolean;
  hasRemote: boolean;
  /**
   * Resolved push destination, or `null` when this branch has none (#11746).
   * Named in the push confirm so the approver sees the repository being written
   * to, which the branch name alone doesn't reveal in a fork workflow.
   */
  pushDestination: GitPushDestination | null;
  worktreePath: string;
  /** Current branch name from the staging status; surfaced in the push confirm dialog. */
  currentBranch?: string | null;
  commitMessage: string;
  onCommitMessageChange: (message: string) => void;
  onCommit: (message: string) => Promise<void>;
  onCommitAndPush: (message: string) => Promise<void>;
  onFocusBlocker?: (blocker: "conflicts" | "staged-files") => void;
  isPushing: boolean;
  pushProgress: Map<string, PushProgressEvent>;
  pushTargetBranch: string | null;
  /** When true, the user has opted out of the push confirm dialog for this worktree. */
  skipPushConfirm: boolean;
  /** Persist the per-worktree opt-out preference. Called only when the user confirms the push. */
  onSetSkipPushConfirm: (value: boolean) => void;
  /**
   * The staging status on screen is the cached snapshot seeded at open and has
   * not been re-read yet. Commit and push wait for the live read so they never
   * act on a file list or branch that may have moved; typing stays open.
   */
  isVerifying?: boolean;
}

export function CommitPanel({
  stagedCount,
  isDetachedHead,
  hasConflicts,
  hasRemote,
  pushDestination,
  worktreePath,
  currentBranch,
  commitMessage,
  onCommitMessageChange,
  onCommit,
  onCommitAndPush,
  onFocusBlocker,
  isPushing,
  pushProgress,
  pushTargetBranch,
  skipPushConfirm,
  onSetSkipPushConfirm,
  isVerifying = false,
}: CommitPanelProps) {
  // Which submit is in flight. Commit & push holds it through the commit and the
  // refresh that follows, so the composer never looks idle before the push starts.
  const [pendingAction, setPendingAction] = useState<"commit" | "commit-push" | null>(null);
  // The count being committed, held from the click: the refresh after the commit
  // drops the live count to what is left, often zero, before the push begins.
  const [pendingCount, setPendingCount] = useState(0);
  const [pushConfirmOpen, setPushConfirmOpen] = useState(false);
  const destinationLabel = pushDestination
    ? `${pushDestination.remote}/${pushDestination.branch}`
    : null;
  const [dontAskChecked, setDontAskChecked] = useState(false);

  const isProtected = isProtectedBranch(currentBranch?.toLowerCase());

  const actionInFlightRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  // Reset by every progress event: an observation that nothing new has arrived,
  // never a claim that the push is stuck.
  const [isPushQuiet, setIsPushQuiet] = useState(false);
  useEffect(() => {
    setIsPushQuiet(false);
    if (!isPushing) return;
    const timer = setTimeout(() => setIsPushQuiet(true), PUSH_QUIET_MS);
    return () => clearTimeout(timer);
  }, [isPushing, pushProgress]);
  const messageId = useId();
  const counterId = useId();
  const statusId = useId();

  const subjectLine = commitMessage.split("\n")[0] || "";
  const isSubjectOverflow = subjectLine.length > MAX_SUBJECT_LENGTH;
  const isCommitting = pendingAction !== null && !isPushing;
  const isBusy = pendingAction !== null || isPushing;
  const actionsBusy = isBusy || isVerifying;
  const canCommit =
    stagedCount > 0 && commitMessage.trim().length > 0 && !isDetachedHead && !hasConflicts;

  // Ordered by where a blocked click sends focus first.
  const blockers = [
    { key: "detached-head" as const, active: isDetachedHead },
    { key: "conflicts" as const, active: hasConflicts },
    { key: "zero-staged" as const, active: stagedCount === 0 },
    { key: "empty-message" as const, active: commitMessage.trim().length === 0 },
  ];

  const primaryBlocker = blockers.find((b) => b.active) ?? null;
  const isBlocked = primaryBlocker !== null;

  const focusBlocker = useCallback(() => {
    if (!primaryBlocker) return;
    switch (primaryBlocker.key) {
      case "detached-head":
        statusRef.current?.focus();
        break;
      case "conflicts":
        onFocusBlocker?.("conflicts");
        break;
      case "zero-staged":
        onFocusBlocker?.("staged-files");
        break;
      case "empty-message":
        textareaRef.current?.focus();
        break;
    }
  }, [primaryBlocker, onFocusBlocker]);

  const historyMessagesRef = useRef<string[] | null>(null);
  const historyIndexRef = useRef(-1);
  const isFetchingHistoryRef = useRef(false);
  const draftBeforeHistoryRef = useRef("");
  const pendingFirstApplyRef = useRef(false);
  const appliedHistoryMessageRef = useRef<string | null>(null);

  useEffect(() => {
    historyMessagesRef.current = null;
    historyIndexRef.current = -1;
    isFetchingHistoryRef.current = false;
    draftBeforeHistoryRef.current = "";
    pendingFirstApplyRef.current = false;
    appliedHistoryMessageRef.current = null;
  }, [worktreePath]);

  const fetchHistoryMessages = useCallback(async (): Promise<string[]> => {
    if (historyMessagesRef.current !== null) return historyMessagesRef.current;
    if (isFetchingHistoryRef.current) {
      while (isFetchingHistoryRef.current) {
        await new Promise((r) => setTimeout(r, HISTORY_FETCH_POLL_INTERVAL_MS));
      }
      return historyMessagesRef.current ?? [];
    }
    isFetchingHistoryRef.current = true;
    try {
      const result = await window.electron.git.listCommits({ cwd: worktreePath, limit: 8 });
      historyMessagesRef.current = result.items
        .map((c) => (c.body?.trim() ? `${c.message}\n\n${c.body.trim()}` : c.message))
        .filter((m) => m.length > 0);
      return historyMessagesRef.current;
    } catch {
      historyMessagesRef.current = [];
      return [];
    } finally {
      isFetchingHistoryRef.current = false;
    }
  }, [worktreePath]);

  const applyHistoryMessage = useCallback(
    (message: string) => {
      appliedHistoryMessageRef.current = message;
      onCommitMessageChange(message);
    },
    [onCommitMessageChange]
  );

  const handleCommit = useCallback(async () => {
    if (!canCommit || actionsBusy) return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setPendingCount(stagedCount);
    setPendingAction("commit");
    try {
      await onCommit(commitMessage);
      onCommitMessageChange("");
    } catch {
      // Error is handled by the parent via setActionError
    } finally {
      setPendingAction(null);
      actionInFlightRef.current = false;
    }
  }, [canCommit, actionsBusy, stagedCount, commitMessage, onCommit, onCommitMessageChange]);

  const handleCommitAndPush = useCallback(async () => {
    if (!canCommit || actionsBusy) return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setPendingCount(stagedCount);
    setPendingAction("commit-push");
    try {
      await onCommitAndPush(commitMessage);
      onCommitMessageChange("");
    } catch {
      // Error is handled by the parent via setActionError
    } finally {
      setPendingAction(null);
      actionInFlightRef.current = false;
    }
  }, [canCommit, actionsBusy, stagedCount, commitMessage, onCommitAndPush, onCommitMessageChange]);

  const handlePrimaryClick = useCallback(() => {
    if (isBlocked) {
      focusBlocker();
      return;
    }
    if (actionsBusy) return;
    if (hasRemote) {
      // D2 confirmation: every remote push is a shared-state mutation. Show
      // the commit message + target branch preview unless the user has opted
      // out for this worktree (#8025).
      //
      // The opt-out is overridden when no destination resolved (#11746): the
      // push will be refused by the handler, and silently attempting it would
      // leave the user with a failed write and no explanation.
      if (!skipPushConfirm || pushDestination === null) {
        setPushConfirmOpen(true);
        return;
      }
      void handleCommitAndPush();
    } else {
      void handleCommit();
    }
  }, [
    isBlocked,
    actionsBusy,
    hasRemote,
    pushDestination,
    skipPushConfirm,
    focusBlocker,
    handleCommitAndPush,
    handleCommit,
  ]);

  const handleConfirmPush = useCallback(() => {
    // The opt-out is persisted on confirm regardless of whether the
    // subsequent push succeeds — the user expressed a preference about the
    // confirm dialog, which is orthogonal to network/rejection failure.
    onSetSkipPushConfirm(dontAskChecked);
    setPushConfirmOpen(false);
    setDontAskChecked(false);
    void handleCommitAndPush();
  }, [dontAskChecked, onSetSkipPushConfirm, handleCommitAndPush]);

  const handleClosePushConfirm = useCallback(() => {
    setPushConfirmOpen(false);
    setDontAskChecked(false);
  }, []);

  const progressEntries = [...pushProgress.values()];

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isHistoryKey = e.key === "ArrowUp" || e.key === "ArrowDown";
      const hasModifier = e.altKey || e.metaKey || e.ctrlKey;
      const isCaretAtStart =
        e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0;
      const visibleMessage = e.currentTarget.value;
      const isAppliedHistoryVisible = appliedHistoryMessageRef.current === visibleMessage;
      const isCyclingHistory =
        pendingFirstApplyRef.current || historyIndexRef.current >= 0 || isAppliedHistoryVisible;

      if (isHistoryKey && !hasModifier && (isCaretAtStart || isCyclingHistory)) {
        e.preventDefault();

        if (e.key === "ArrowUp") {
          if (historyIndexRef.current < 0) {
            const cachedIndex = isAppliedHistoryVisible
              ? (historyMessagesRef.current?.indexOf(visibleMessage) ?? -1)
              : -1;
            if (cachedIndex >= 0) {
              historyIndexRef.current = cachedIndex;
              pendingFirstApplyRef.current = false;
            } else {
              draftBeforeHistoryRef.current = visibleMessage;
              pendingFirstApplyRef.current = true;
            }
          }

          const messages = historyMessagesRef.current;
          if (messages !== null) {
            if (messages.length === 0) return;

            if (pendingFirstApplyRef.current) {
              pendingFirstApplyRef.current = false;
              historyIndexRef.current = 0;
              applyHistoryMessage(messages[0]!);
            } else if (historyIndexRef.current < messages.length - 1) {
              historyIndexRef.current++;
              applyHistoryMessage(messages[historyIndexRef.current]!);
            }

            requestAnimationFrame(() => {
              textareaRef.current?.setSelectionRange(0, 0);
            });
          } else {
            void fetchHistoryMessages().then((msgs) => {
              if (msgs.length === 0) return;

              if (pendingFirstApplyRef.current) {
                const visibleIndex = msgs.indexOf(visibleMessage);
                if (visibleIndex >= 0) {
                  pendingFirstApplyRef.current = false;
                  historyIndexRef.current = visibleIndex;
                  if (historyIndexRef.current < msgs.length - 1) {
                    historyIndexRef.current++;
                    applyHistoryMessage(msgs[historyIndexRef.current]!);
                  }
                } else {
                  pendingFirstApplyRef.current = false;
                  historyIndexRef.current = 0;
                  applyHistoryMessage(msgs[0]!);
                }
              }

              requestAnimationFrame(() => {
                textareaRef.current?.setSelectionRange(0, 0);
              });
            });
          }
        } else {
          if (historyIndexRef.current < 0) return;
          historyIndexRef.current--;
          if (historyIndexRef.current < 0) {
            pendingFirstApplyRef.current = false;
            appliedHistoryMessageRef.current = null;
            onCommitMessageChange(draftBeforeHistoryRef.current);
          } else {
            const messages = historyMessagesRef.current!;
            applyHistoryMessage(messages[historyIndexRef.current]!);
          }

          requestAnimationFrame(() => {
            textareaRef.current?.setSelectionRange(0, 0);
          });
        }
        return;
      }

      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (isBlocked) {
          focusBlocker();
          return;
        }
        if (e.shiftKey && hasRemote) {
          void handleCommit();
        } else {
          void handlePrimaryClick();
        }
      }
    },
    [
      handlePrimaryClick,
      handleCommit,
      hasRemote,
      isBlocked,
      focusBlocker,
      fetchHistoryMessages,
      applyHistoryMessage,
      onCommitMessageChange,
    ]
  );

  const onMac = isMac();
  const primaryLabel = hasRemote ? "Commit & push" : "Commit";
  const primaryBusy = hasRemote ? pendingAction === "commit-push" || isPushing : isCommitting;
  const primaryKeyshortcuts = comboToAriaKeyshortcuts(PRIMARY_SHORTCUT, onMac);
  const pushTarget = pushTargetBranch ?? destinationLabel;
  const stagedSummary = `${formatFileCount(stagedCount)} staged`;

  // One line under the message box answers "can I commit, and if so what happens".
  // It replaces a hover-only checklist: the buttons point at it with
  // aria-describedby, and a blocked click lands focus on whatever it names.
  let statusTone: "neutral" | "warning" = "neutral";
  let statusContent: React.ReactNode;
  let statusTitle: string | undefined;
  if (isPushing) {
    statusContent = pushTarget ? (
      <>
        Pushing to <span className="font-mono text-text-primary">{pushTarget}</span>
      </>
    ) : (
      "Pushing…"
    );
    statusTitle = pushTarget ? `Pushing to ${pushTarget}` : undefined;
  } else if (isCommitting) {
    statusContent = `Committing ${formatFileCount(pendingCount)}…`;
  } else if (isBlocked) {
    statusTone = isDetachedHead || hasConflicts ? "warning" : "neutral";
    statusContent = describeBlockers({
      isDetachedHead,
      hasConflicts,
      needsStaging: stagedCount === 0,
      needsMessage: commitMessage.trim().length === 0,
      stagedSummary,
    });
  } else if (isVerifying) {
    statusContent = "Checking staged changes…";
  } else if (hasRemote) {
    statusContent = destinationLabel ? (
      <>
        {stagedSummary} · pushes to{" "}
        <span className="font-mono text-text-primary">{destinationLabel}</span>
      </>
    ) : (
      `${stagedSummary} · no push destination set`
    );
    statusTitle = destinationLabel ? `${stagedSummary} · pushes to ${destinationLabel}` : undefined;
  } else {
    statusContent = stagedSummary;
  }

  const showShortcut = !isBlocked && !actionsBusy;
  const progressRows = isPushing ? progressEntries : [];

  return (
    <div className="border-t border-divider p-3 space-y-2" data-testid="review-hub-commit-panel">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={messageId} className="text-xs font-medium text-text-secondary">
          Commit message
        </label>
        <span
          id={counterId}
          className={cn(
            "inline-flex items-center gap-1 text-2xs tabular-nums",
            // Warning ink measured just under 4.5:1 on the light themes. The glyph
            // carries the tone; the numbers stay in primary ink.
            isSubjectOverflow ? "font-medium text-text-primary" : "text-text-secondary"
          )}
        >
          {isSubjectOverflow && (
            <AlertTriangle
              className="w-3 h-3 shrink-0 text-status-warning"
              aria-hidden="true"
              data-severity-glyph=""
            />
          )}
          {subjectLine.length}/{MAX_SUBJECT_LENGTH}
          <span className="sr-only">
            {isSubjectOverflow
              ? " characters in the subject line, over the recommended length"
              : " characters in the subject line"}
          </span>
        </span>
      </div>

      <Textarea
        ref={textareaRef}
        id={messageId}
        data-testid="review-hub-commit-message"
        value={commitMessage}
        onChange={(e) => {
          if (e.target.value !== appliedHistoryMessageRef.current) {
            historyIndexRef.current = -1;
            pendingFirstApplyRef.current = false;
            appliedHistoryMessageRef.current = null;
          }
          onCommitMessageChange(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Summary on the first line, details below"
        aria-describedby={counterId}
        rows={2}
        disabled={isBusy || isDetachedHead}
        variant="code"
        resize="none"
        style={
          {
            // Two layers so the ruler aligns to the text (content box) while the
            // fill still reaches the border: background-color takes the clip of
            // the LAST layer, and a single content-box layer left the padding
            // unpainted, a box inside a box on every theme with its own input fill.
            backgroundImage: `linear-gradient(to right, transparent 72ch, var(--color-border-subtle) 72ch, var(--color-border-subtle) calc(72ch + 1px), transparent calc(72ch + 1px)), none`,
            backgroundOrigin: "content-box, padding-box",
            backgroundClip: "content-box, padding-box",
            backgroundAttachment: "local",
            fieldSizing: "content",
          } as React.CSSProperties
        }
        className={cn(
          // Fallback keeps themes without --review-commit-input-bg byte-identical.
          "bg-[var(--review-commit-input-bg,var(--color-surface-canvas))]",
          "min-h-[calc(2lh+1rem)] max-h-[calc(6lh+1rem)] overflow-y-auto"
        )}
      />

      <p
        ref={statusRef}
        id={statusId}
        tabIndex={-1}
        title={statusTitle}
        data-testid="review-hub-commit-status"
        className={cn(
          "flex items-center gap-1.5 min-h-5 text-xs text-text-secondary rounded-[var(--radius-sm)]",
          // `focus:`, not `focus-visible:`: a blocked click moves focus here by
          // script, and Chromium would not ring that after a pointer click, so a
          // mouse user would see nothing happen.
          "focus:outline focus:outline-2 focus:outline-accent-primary focus:outline-offset-2"
        )}
      >
        {statusTone === "warning" && (
          <AlertTriangle
            className="w-3.5 h-3.5 shrink-0 text-status-warning"
            aria-hidden="true"
            data-severity-glyph=""
          />
        )}
        {/* A blocker wraps so every requirement stays readable at any width; the
            ready and pushing lines truncate a long destination instead. */}
        <span className={cn("min-w-0", isBlocked && !isBusy ? "break-words" : "truncate")}>
          {statusContent}
        </span>
        {isPushing && isPushQuiet && (
          // Its own slot, so a long destination truncating beside it can never
          // hide the one line explaining a pause.
          <span className="shrink-0 whitespace-nowrap">
            · no new progress in the last {PUSH_QUIET_MS / 1000}s
          </span>
        )}
        {showShortcut && (
          <KbdChord
            shortcut={PRIMARY_SHORTCUT}
            density="compact"
            className="ml-auto shrink-0"
            aria-label={`${primaryLabel} shortcut`}
          />
        )}
      </p>

      {/* The visible status line is not live — it changes on every keystroke that
          empties or fills the message. This region speaks the push only. */}
      <span role="status" className="sr-only">
        {isPushing && pushTarget ? `Pushing to ${pushTarget}` : ""}
      </span>

      {progressRows.length > 0 && (
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 text-2xs text-text-secondary">
          {progressRows.map((e) => {
            const label = pushStageLabel(e.stage);
            // Git reports some stages (remote hook output, mostly) with no
            // percentage. A bar would draw that as 0%; say what was seen instead.
            if (e.progress == null) {
              return (
                <div key={e.stage} className="contents">
                  <span className="whitespace-nowrap">{label}</span>
                  <span className="col-span-2 truncate">Reported, no percentage</span>
                </div>
              );
            }
            const value = Math.min(100, Math.max(0, Math.round(e.progress)));
            return (
              <div key={e.stage} className="contents">
                <span className="whitespace-nowrap">{label}</span>
                <div
                  role="progressbar"
                  aria-label={label}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={value}
                  className="h-1 rounded-full bg-overlay-soft overflow-hidden"
                >
                  <div
                    className="h-full rounded-full bg-text-secondary transition-[width] duration-150 ease-out"
                    style={{ width: `${value}%` }}
                  />
                </div>
                <span className="tabular-nums text-right min-w-[4ch]" aria-hidden="true">
                  {value}%
                </span>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        isOpen={pushConfirmOpen}
        onClose={handleClosePushConfirm}
        // Fixed, matching `GitPushConfirmDialog` (#11979/#11980). It used to
        // interpolate `destinationLabel ?? currentBranch ?? ""`, which asked
        // `Push to ''?` before the destination resolved and silently changed the
        // quoted string from naming a REMOTE ref to naming a LOCAL branch between
        // states. The destination belongs in the body, which can say "not resolved".
        title="Push commits?"
        description={
          isProtected ? (
            <span>
              <span className="font-mono">{currentBranch ?? ""}</span> is a protected branch. Most
              teams use pull requests instead. Review your commit message before pushing:
            </span>
          ) : (
            <span>Review your commit message before pushing:</span>
          )
        }
        confirmLabel={`Push to ${destinationLabel ?? currentBranch ?? "branch"}`}
        confirmDisabled={pushDestination === null}
        variant="default"
        zIndex="nested"
        onConfirm={handleConfirmPush}
      >
        <div className="flex flex-col gap-2">
          {pushDestination === null && (
            <Callout severity="warning" data-testid="commit-panel-push-no-destination">
              <p>
                No push destination is configured for this branch. Set an upstream, or configure a
                push remote, before pushing.
              </p>
            </Callout>
          )}
          <div>
            <RefChip
              data-testid="commit-panel-push-confirm-branch"
              value={destinationLabel ?? currentBranch ?? ""}
            />
          </div>
          <pre
            data-testid="commit-panel-push-confirm-message"
            className={cn(
              "max-h-40 overflow-y-auto rounded-[var(--radius-md)] border border-divider",
              "bg-surface-inset px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words text-text-primary"
            )}
          >
            {commitMessage}
          </pre>
          <label className="flex cursor-pointer items-start gap-2 text-sm text-text-primary select-none">
            <Checkbox
              data-testid="commit-panel-push-confirm-dont-ask"
              checked={dontAskChecked}
              onCheckedChange={(checked) => setDontAskChecked(checked === true)}
              className="mt-0.5"
            />
            Don't ask again for this worktree
          </label>
        </div>
      </ConfirmDialog>

      <div className="flex items-center gap-2">
        {hasRemote && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="review-hub-commit-only"
            onClick={() => {
              if (isBlocked) {
                focusBlocker();
                return;
              }
              if (actionsBusy) return;
              void handleCommit();
            }}
            loading={pendingAction === "commit"}
            aria-disabled={!canCommit || actionsBusy || undefined}
            aria-describedby={statusId}
            // Opacity, as the Button primitive's own disabled state does: a ghost has
            // no surface to change, and muted ink alone sits too close to its
            // secondary resting ink to read as unavailable.
            className="aria-disabled:opacity-50 aria-disabled:cursor-not-allowed forced-colors:aria-disabled:text-[GrayText]"
          >
            <GitCommit aria-hidden="true" />
            Commit
          </Button>
        )}
        <Button
          variant="default"
          size="sm"
          data-testid="review-hub-commit-primary"
          data-staged-count={stagedCount}
          onClick={handlePrimaryClick}
          aria-disabled={!canCommit || actionsBusy || undefined}
          aria-describedby={statusId}
          aria-keyshortcuts={primaryKeyshortcuts}
          loading={primaryBusy}
          // Busy keeps the CTA's own fill under the spinner; the inset treatment
          // is for "can't commit", not "committing".
          className={cn("flex-1", !primaryBusy && DISABLED_CTA_CLASSES)}
        >
          {hasRemote ? <ArrowUpFromLine aria-hidden="true" /> : <GitCommit aria-hidden="true" />}
          {primaryLabel}
        </Button>
      </div>
    </div>
  );
}
