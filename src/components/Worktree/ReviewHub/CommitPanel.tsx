import { useState, useCallback, useRef, useEffect } from "react";
import type { PushProgressEvent } from "@shared/types/ipc/gitPush";
import { cn } from "@/lib/utils";
import { GitCommit, ArrowUpFromLine, Check, CircleX } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { isProtectedBranch } from "@shared/utils/gitConstants";

const MAX_SUBJECT_LENGTH = 72;
const HISTORY_FETCH_POLL_INTERVAL_MS = 10;

interface CommitPanelProps {
  stagedCount: number;
  isDetachedHead: boolean;
  hasConflicts: boolean;
  hasRemote: boolean;
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
}

export function CommitPanel({
  stagedCount,
  isDetachedHead,
  hasConflicts,
  hasRemote,
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
}: CommitPanelProps) {
  const [isCommitting, setIsCommitting] = useState(false);
  const [pushConfirmOpen, setPushConfirmOpen] = useState(false);
  const [dontAskChecked, setDontAskChecked] = useState(false);

  const isProtected = isProtectedBranch(currentBranch?.toLowerCase());

  const actionInFlightRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const detachedHeadRef = useRef<HTMLDivElement>(null);

  const subjectLine = commitMessage.split("\n")[0] || "";
  const hasLineOverflow = /.{73,}/.test(commitMessage);
  const isBusy = isCommitting || isPushing;
  const canCommit =
    stagedCount > 0 && commitMessage.trim().length > 0 && !isDetachedHead && !hasConflicts;

  const blockers = [
    { key: "detached-head" as const, active: isDetachedHead, label: "Not on detached HEAD" },
    { key: "conflicts" as const, active: hasConflicts, label: "No merge conflicts" },
    { key: "zero-staged" as const, active: stagedCount === 0, label: "Files staged for commit" },
    {
      key: "empty-message" as const,
      active: commitMessage.trim().length === 0,
      label: "Commit message entered",
    },
  ];

  const primaryBlocker = blockers.find((b) => b.active) ?? null;
  const isBlocked = primaryBlocker !== null;

  const focusBlocker = useCallback(() => {
    if (!primaryBlocker) return;
    switch (primaryBlocker.key) {
      case "detached-head":
        detachedHeadRef.current?.focus();
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
    if (!canCommit || isBusy) return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setIsCommitting(true);
    try {
      await onCommit(commitMessage);
      onCommitMessageChange("");
    } catch {
      // Error is handled by the parent via setActionError
    } finally {
      setIsCommitting(false);
      actionInFlightRef.current = false;
    }
  }, [canCommit, isBusy, commitMessage, onCommit, onCommitMessageChange]);

  const handleCommitAndPush = useCallback(async () => {
    if (!canCommit || isBusy) return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    try {
      await onCommitAndPush(commitMessage);
      onCommitMessageChange("");
    } catch {
      // Error is handled by the parent via setActionError
    } finally {
      actionInFlightRef.current = false;
    }
  }, [canCommit, isBusy, commitMessage, onCommitAndPush, onCommitMessageChange]);

  const handlePrimaryClick = useCallback(() => {
    if (isBlocked) {
      focusBlocker();
      return;
    }
    if (isBusy) return;
    if (hasRemote) {
      // D2 confirmation: every remote push is a shared-state mutation. Show
      // the commit message + target branch preview unless the user has opted
      // out for this worktree (#8025).
      if (!skipPushConfirm) {
        setPushConfirmOpen(true);
        return;
      }
      void handleCommitAndPush();
    } else {
      void handleCommit();
    }
  }, [
    isBlocked,
    isBusy,
    hasRemote,
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
  const hasProgress = progressEntries.length > 0;

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

  const blockerTooltip = (
    <div>
      <div className="text-[11px] font-semibold text-daintree-text/60 mb-2">Cannot commit</div>
      <ul className="flex flex-col gap-1.5 text-xs">
        {blockers.map((b) => (
          <li key={b.key} className="flex items-center gap-2">
            {b.active ? (
              <CircleX className="w-3 h-3 text-status-error shrink-0" />
            ) : (
              <Check className="w-3 h-3 text-status-success shrink-0" />
            )}
            <span
              className={b.active ? "text-daintree-text" : "text-daintree-text/40 line-through"}
            >
              {b.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );

  const primaryLabel = hasRemote ? "Commit & Push" : "Commit";

  return (
    <div className="border-t border-divider p-3 space-y-2">
      {isDetachedHead && (
        <div
          ref={detachedHeadRef}
          tabIndex={-1}
          className="text-xs text-status-warning bg-status-warning/10 rounded px-2 py-1.5 outline-hidden focus:ring-2 focus:ring-daintree-accent/30"
        >
          Detached HEAD — commits are not allowed in this state.
        </div>
      )}

      <textarea
        ref={textareaRef}
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
        placeholder="Commit message…"
        rows={2}
        disabled={isBusy || isDetachedHead}
        style={
          {
            backgroundImage: `linear-gradient(to right, transparent 72ch, var(--color-border-subtle) 72ch, var(--color-border-subtle) calc(72ch + 1px), transparent calc(72ch + 1px))`,
            backgroundOrigin: "content-box",
            backgroundClip: "content-box",
            backgroundAttachment: "local",
            fieldSizing: "content",
          } as React.CSSProperties
        }
        className={cn(
          // Fallback keeps themes without --review-commit-input-bg byte-identical.
          "w-full resize-none rounded-md border border-divider bg-[var(--review-commit-input-bg,var(--color-daintree-bg))] px-3 py-2 text-xs font-mono",
          "min-h-[calc(2lh+1rem)] max-h-[calc(6lh+1rem)] overflow-y-auto",
          "placeholder:text-text-placeholder text-daintree-text",
          "focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/30 focus:border-transparent",
          "disabled:opacity-50 disabled:cursor-not-allowed"
        )}
      />
      <div
        className={cn(
          "flex justify-end text-[10px] tabular-nums -mt-1",
          hasLineOverflow ? "text-status-warning" : "text-daintree-text/40"
        )}
      >
        {subjectLine.length}/{MAX_SUBJECT_LENGTH}
      </div>

      {isPushing && pushTargetBranch && (
        <div className="text-[10px] text-daintree-text/50 truncate">
          Pushing to <span className="text-daintree-text/70 font-mono">{pushTargetBranch}</span>
        </div>
      )}

      {isPushing && hasProgress && (
        <div className="space-y-1">
          {progressEntries.map((e) => (
            <div
              key={e.stage}
              className="flex items-center gap-2 text-[10px] text-daintree-text/70"
            >
              <span className="w-20 truncate capitalize">{e.stage}</span>
              <div className="flex-1 h-1 bg-daintree-bg rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-[width] duration-300 ease-out"
                  style={{ width: `${Math.min(100, Math.max(0, e.progress ?? 0))}%` }}
                />
              </div>
              {e.progress != null && (
                <span className="tabular-nums w-8 text-right">{e.progress}%</span>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={pushConfirmOpen}
        onClose={handleClosePushConfirm}
        title={`Push to '${currentBranch ?? ""}'?`}
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
        confirmLabel={`Push to ${currentBranch ?? "branch"}`}
        variant="default"
        zIndex="nested"
        onConfirm={handleConfirmPush}
      >
        <div className="flex flex-col gap-2">
          <div>
            <span
              data-testid="commit-panel-push-confirm-branch"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-tint/[0.07] border border-tint/[0.08] text-[11px] font-mono text-daintree-text"
            >
              {currentBranch ?? ""}
            </span>
          </div>
          <pre
            data-testid="commit-panel-push-confirm-message"
            className={cn(
              "max-h-40 overflow-y-auto rounded-[var(--radius-md)] border border-divider",
              "bg-surface-inset px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words text-daintree-text"
            )}
          >
            {commitMessage}
          </pre>
          <label className="flex items-center gap-2 text-xs text-daintree-text/60 select-none">
            <input
              type="checkbox"
              data-testid="commit-panel-push-confirm-dont-ask"
              checked={dontAskChecked}
              onChange={(e) => setDontAskChecked(e.target.checked)}
              className="accent-daintree-accent"
            />
            Don't ask again for this worktree
          </label>
        </div>
      </ConfirmDialog>

      <div className="flex items-center gap-2">
        {hasRemote ? (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 flex-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (isBlocked) {
                      focusBlocker();
                      return;
                    }
                    if (isBusy) return;
                    void handleCommit();
                  }}
                  aria-disabled={!canCommit || isBusy || undefined}
                  className="aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                >
                  {isCommitting ? (
                    <Spinner size="sm" className="mr-1.5" />
                  ) : (
                    <GitCommit className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  Commit
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handlePrimaryClick}
                  aria-disabled={!canCommit || isBusy || undefined}
                  className={cn(
                    "flex-1",
                    "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                  )}
                >
                  {isPushing ? (
                    <Spinner size="sm" className="mr-1.5" />
                  ) : (
                    <ArrowUpFromLine className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  {primaryLabel} ({stagedCount})
                </Button>
              </div>
            </TooltipTrigger>
            {isBlocked && (
              <TooltipContent side="top" align="center" className="p-3 max-w-[260px]">
                {blockerTooltip}
              </TooltipContent>
            )}
          </Tooltip>
        ) : (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant="default"
                size="sm"
                onClick={handlePrimaryClick}
                aria-disabled={!canCommit || isBusy || undefined}
                className={cn(
                  "flex-1",
                  "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                )}
              >
                {isCommitting ? (
                  <Spinner size="sm" className="mr-1.5" />
                ) : (
                  <GitCommit className="w-3.5 h-3.5 mr-1.5" />
                )}
                Commit ({stagedCount})
              </Button>
            </TooltipTrigger>
            {isBlocked && (
              <TooltipContent side="top" align="center" className="p-3 max-w-[260px]">
                {blockerTooltip}
              </TooltipContent>
            )}
          </Tooltip>
        )}
      </div>
    </div>
  );
}
