import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Bell, AlertTriangle, AlertCircle, CheckCircle2, Pin } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/store/uiStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import type { ReEntrySummaryState } from "@/hooks/useReEntrySummary";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";

const AUTO_DISMISS_MS = 8000;

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
  const [isVisible, setIsVisible] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const entryCount = entries.length;

  useEffect(() => {
    if (!visible) {
      setIsVisible(false);
      return;
    }
    setIsPinned(false);
    const handle = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(handle);
  }, [visible, entryCount]);

  const rowsKey = rows.map((r) => r.worktreeId).join(",");

  useEffect(() => {
    if (!visible || isPaused || isPinned) return;
    const timer = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [visible, dismiss, isPaused, isPinned, rowsKey]);

  if (!state.visible) return null;

  const hasUrgent = rows.some((r) => r.worstType === "error" || r.worstType === "warning");
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
          "pointer-events-auto relative flex flex-col w-full max-w-[360px]",
          "rounded-[var(--radius-sm)] border-l-[3px] border border-tint/[0.08]",
          "bg-surface-panel/85 backdrop-blur-xl",
          "px-3 py-2.5 pr-2",
          "text-sm text-daintree-text",
          "shadow-[var(--theme-shadow-floating)]",
          "ring-1 ring-inset ring-tint/[0.05]",
          // Tailwind v4 translate-* emits the individual `translate` property,
          // which `transform` in a transition list does NOT cover — list it
          // explicitly or the slide-in snaps and only the fade animates.
          "transition-[translate,opacity] duration-300 ease-out",
          "motion-reduce:transition-none motion-reduce:duration-0",
          isVisible ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0",
          accentClass
        )}
        role="status"
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
      >
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-medium leading-tight tracking-tight text-xs text-daintree-text">
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
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2",
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
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
              )}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <ul className="mt-1.5 space-y-0.5">
          {rows.map((row) => {
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
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2",
                    row.worstType === "error" || row.worstType === "warning"
                      ? "text-daintree-text"
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
          {overflowCount > 0 && (
            <li>
              <button
                type="button"
                onClick={handleOpenNotifications}
                className={cn(
                  "text-xs text-daintree-text/50 hover:text-daintree-text/70",
                  "px-0.5 py-0.5 transition-colors duration-150"
                )}
              >
                +{overflowCount} more
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
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
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
