import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Bell, AlertTriangle, AlertCircle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/store/uiStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { ReEntrySummaryState } from "@/hooks/useReEntrySummary";

const AUTO_DISMISS_MS = 8000;

function buildLines(counts: ReEntrySummaryState["counts"]): Array<{
  icon: typeof AlertCircle;
  text: string;
  emphasis: boolean;
}> {
  const lines: Array<{ icon: typeof AlertCircle; text: string; emphasis: boolean }> = [];
  if (counts.error > 0) {
    lines.push({
      icon: AlertCircle,
      text: `${counts.error} failed`,
      emphasis: true,
    });
  }
  if (counts.warning > 0) {
    lines.push({
      icon: AlertTriangle,
      text: `${counts.warning} waiting for input`,
      emphasis: true,
    });
  }
  if (counts.success > 0) {
    lines.push({
      icon: CheckCircle2,
      text: `${counts.success} completed`,
      emphasis: false,
    });
  }
  if (counts.info > 0) {
    lines.push({
      icon: Bell,
      text: `${counts.info} update${counts.info !== 1 ? "s" : ""}`,
      emphasis: false,
    });
  }
  return lines;
}

export function ReEntrySummary({ state }: { state: ReEntrySummaryState }) {
  const { visible, dismiss, entries } = state;
  const [isVisible, setIsVisible] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const entryCount = entries.length;

  useEffect(() => {
    if (!visible) {
      setIsVisible(false);
      return;
    }
    const handle = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(handle);
  }, [visible, entryCount]);

  useEffect(() => {
    if (!visible || isPaused) return;
    const timer = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [visible, dismiss, isPaused, entryCount]);

  if (!state.visible) return null;

  const lines = buildLines(state.counts);
  const hasUrgent = state.counts.error > 0 || state.counts.warning > 0;
  const accentClass = hasUrgent ? "border-l-status-warning" : "border-l-status-success";

  const handleOpenNotifications = () => {
    useUIStore.getState().openNotificationCenter();
    state.dismiss();
  };

  const handleGoToWorktree = () => {
    if (state.singleWorktreeId) {
      useWorktreeSelectionStore.getState().selectWorktree(state.singleWorktreeId);
    }
    state.dismiss();
  };

  return createPortal(
    <div
      className="fixed top-3 z-[var(--z-toast)] flex flex-col gap-3 w-full max-w-[380px] pointer-events-none p-4"
      style={{ right: "calc(var(--portal-right-offset, 0px))" }}
    >
      <div
        className={cn(
          "pointer-events-auto relative flex flex-col w-full max-w-[360px]",
          "rounded-[var(--radius-sm)] border-l-[3px] border border-tint/[0.08]",
          "bg-surface-panel/85 backdrop-blur-xl",
          "px-3 py-2.5 pr-2",
          "text-sm text-canopy-text",
          "shadow-[var(--theme-shadow-floating)]",
          "ring-1 ring-inset ring-tint/[0.05]",
          "transition-[transform,opacity] duration-300 ease-out",
          "motion-reduce:transition-none motion-reduce:duration-0",
          isVisible ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0",
          accentClass
        )}
        role="status"
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
      >
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-medium leading-tight tracking-tight text-xs text-canopy-text">
            While you were away
          </h4>
          <button
            type="button"
            onClick={state.dismiss}
            aria-label="Dismiss summary"
            className={cn(
              "shrink-0 rounded-[var(--radius-xs)]",
              "h-6 w-6 flex items-center justify-center",
              "text-canopy-text/40 transition-colors duration-150",
              "hover:text-canopy-text/80 hover:bg-tint/10",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
            )}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <ul className="mt-1.5 space-y-0.5">
          {lines.map((line) => (
            <li
              key={line.text}
              className={cn(
                "flex items-center gap-1.5 text-xs",
                line.emphasis ? "text-canopy-text" : "text-canopy-text/70"
              )}
            >
              <line.icon className="h-3.5 w-3.5 shrink-0" />
              <span className="tabular-nums">{line.text}</span>
            </li>
          ))}
        </ul>

        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={handleOpenNotifications}
            className={cn(
              "px-2.5 py-1 rounded-[var(--radius-xs)]",
              "text-xs font-medium",
              "bg-canopy-accent/10 text-canopy-accent",
              "hover:bg-canopy-accent/20 transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
            )}
          >
            Open Notifications
          </button>
          {state.singleWorktreeId && (
            <button
              type="button"
              onClick={handleGoToWorktree}
              className={cn(
                "px-2.5 py-1 rounded-[var(--radius-xs)]",
                "text-xs font-medium",
                "bg-tint/5 text-canopy-text/70",
                "hover:bg-tint/10 hover:text-canopy-text transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
              )}
            >
              Go to Worktree
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
