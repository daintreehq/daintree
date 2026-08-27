import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Bell, AlertTriangle, AlertCircle, CheckCircle2, Pin } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/store/uiStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
  getUiTransitionDuration,
} from "@/lib/animationUtils";
import type { ReEntrySummaryState } from "@/hooks/useReEntrySummary";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";

export const AUTO_DISMISS_MS = 8000;

const SEVERITY_ICON: Record<NotificationHistoryEntry["type"], typeof AlertCircle> = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Bell,
  success: CheckCircle2,
};

const SEVERITY_CLASS: Record<NotificationHistoryEntry["type"], string> = {
  error: "text-status-error",
  warning: "text-status-warning",
  info: "text-status-info",
  success: "text-status-success",
};

export function ReEntrySummary({ state }: { state: ReEntrySummaryState }) {
  const { visible, dismiss, entries, rows, overflowCount } = state;
  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen: visible,
    animationDuration: getUiTransitionDuration("exit"),
  });
  const [isPaused, setIsPaused] = useState(false);
  const [isPinned, setIsPinned] = useState(false);

  // Identity of the summary being shown. Entry ids are unique and a dismissed
  // batch is never re-summarized, so this changes exactly when a new summary
  // arrives — unlike the entry count or the worktree-id list, which collide
  // when the same worktrees report again and would leave a replacement summary
  // inheriting the previous one's pin and its already-half-elapsed timer.
  const entriesKey = entries.map((e) => e.id).join(",");

  useEffect(() => {
    if (visible) setIsPinned(false);
  }, [visible, entriesKey]);

  // Hover pause is transient: clear it once the card is gone. onMouseLeave does
  // not fire for a node removed out from under the pointer (dismissing while
  // hovering), and this component instance never unmounts — it just renders
  // null — so a stuck `isPaused` would silently disable auto-dismiss for every
  // later summary.
  useEffect(() => {
    if (!shouldRender) setIsPaused(false);
  }, [shouldRender]);

  useEffect(() => {
    if (!visible || isPaused || isPinned) return;
    const timer = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [visible, dismiss, isPaused, isPinned, entriesKey]);

  // Latch the last visible content so the card keeps rendering the rows it had
  // while it slides out. `useReEntrySummary` returns EMPTY the instant `visible`
  // flips false, so without this the exit would animate a blank card — the same
  // bug ScrollIndicator solves for its count (#10316). State adjusted during
  // render, not a ref: React discards an abandoned concurrent render's state
  // update, so stale rows can't leak in.
  const [content, setContent] = useState({ rows, overflowCount });
  if (visible && (content.rows !== rows || content.overflowCount !== overflowCount)) {
    setContent({ rows, overflowCount });
  }

  if (!shouldRender) return null;

  const { rows: displayRows, overflowCount: displayOverflowCount } = content;
  const hasUrgent = displayRows.some((r) => r.worstType === "error" || r.worstType === "warning");
  const accentClass = hasUrgent ? "border-l-status-warning" : "border-l-status-success";

  const handleOpenNotifications = () => {
    useUIStore.getState().openNotificationCenter();
    state.dismiss();
  };

  const handleRowClick = (worktreeId: string) => {
    const hasWorktree = getCurrentViewStoreOrNull()?.getState().worktrees.has(worktreeId) ?? false;
    if (!hasWorktree) return;
    useWorktreeSelectionStore.getState().selectWorktree(worktreeId);
    state.dismiss();
  };

  return createPortal(
    <div
      className="fixed top-3 z-[var(--z-toast)] flex flex-col gap-3 w-full max-w-[380px] pointer-events-none p-4"
      style={{ right: "calc(var(--right-obstruction-offset, 0px))" }}
    >
      <div
        className={cn(
          "relative flex flex-col w-full max-w-[360px]",
          "rounded-[var(--radius-sm)] border-l-[3px] border border-tint/[0.08]",
          "bg-surface-panel/85 backdrop-blur-xl",
          "px-3 py-2.5 pr-2",
          "text-sm text-text-primary",
          "shadow-[var(--theme-shadow-floating)]",
          "ring-1 ring-inset ring-tint/[0.05]",
          // Tailwind v4 translate-* emits the individual `translate` property,
          // which `transform` in a transition list does NOT cover — list it
          // explicitly or the slide snaps and only the fade animates.
          "transition-[translate,opacity]",
          "motion-reduce:transition-none motion-reduce:duration-0",
          isVisible
            ? "pointer-events-auto translate-x-0 opacity-100"
            : "pointer-events-none translate-x-8 opacity-0",
          accentClass
        )}
        style={{
          transitionDuration: isVisible ? `${UI_ENTER_DURATION}ms` : `${UI_EXIT_DURATION}ms`,
          transitionTimingFunction: isVisible ? UI_ENTER_EASING : UI_EXIT_EASING,
        }}
        // Real inertness while sliding out: pointer-events alone still lets a
        // Tab/Enter land on the fading card's buttons. `inert` also blurs the
        // focused dismiss button for us — aria-hidden would not, and Chromium
        // blocks aria-hidden over a focused element. Keyed on the incoming
        // `visible`, not `isVisible`: the latter is also false for the hidden
        // entry frame, and inert there would drop this role="status" live
        // region out of the a11y tree exactly as it's inserted.
        inert={!visible}
        role="status"
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
      >
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-medium leading-tight tracking-tight text-xs text-text-primary">
            While you were away
          </h4>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setIsPinned((p) => !p)}
              aria-label={isPinned ? "Unpin summary" : "Pin summary"}
              aria-pressed={isPinned}
              className={cn(
                "shrink-0 rounded-[var(--radius-xs)]",
                "h-6 w-6 flex items-center justify-center",
                "text-daintree-text/40 transition-colors duration-150",
                "hover:text-daintree-text/80 hover:bg-tint/10",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                isPinned && "text-daintree-text/80"
              )}
            >
              <Pin className={cn("h-3.5 w-3.5", isPinned && "fill-current")} />
            </button>
            <button
              type="button"
              onClick={state.dismiss}
              aria-label="Dismiss summary"
              className={cn(
                "shrink-0 rounded-[var(--radius-xs)]",
                "h-6 w-6 flex items-center justify-center",
                "text-daintree-text/40 transition-colors duration-150",
                "hover:text-daintree-text/80 hover:bg-tint/10",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
              )}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <ul className="mt-1.5 space-y-0.5">
          {displayRows.map((row) => {
            const Icon = SEVERITY_ICON[row.worstType];
            return (
              <li key={row.worktreeId}>
                <button
                  type="button"
                  onClick={() => handleRowClick(row.worktreeId)}
                  className={cn(
                    "flex items-center gap-1.5 w-full text-left text-xs",
                    "rounded-[var(--radius-xs)] px-0.5 py-0.5 -mx-0.5",
                    "hover:bg-tint/5 transition-colors duration-150",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                    row.worstType === "error" || row.worstType === "warning"
                      ? "text-text-primary"
                      : "text-daintree-text/70"
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5 shrink-0", SEVERITY_CLASS[row.worstType])} />
                  <span className="font-medium truncate min-w-0">{row.worktreeName}</span>
                  <span className="text-daintree-text/50 truncate min-w-0">
                    {row.highlightTitle}
                  </span>
                </button>
              </li>
            );
          })}
          {displayOverflowCount > 0 && (
            <li>
              <button
                type="button"
                onClick={handleOpenNotifications}
                className={cn(
                  "text-xs text-daintree-text/50 hover:text-daintree-text/70",
                  "px-0.5 py-0.5 transition-colors duration-150"
                )}
              >
                +{displayOverflowCount} more
              </button>
            </li>
          )}
        </ul>

        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={handleOpenNotifications}
            className={cn(
              "px-2.5 py-1 rounded-[var(--radius-xs)]",
              "text-xs font-medium",
              "bg-status-info/10 text-status-info",
              "hover:bg-status-info/20 transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
            )}
          >
            Open Notifications
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
