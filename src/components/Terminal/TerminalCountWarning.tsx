import { useState, useEffect, useCallback } from "react";
import { X, AlertTriangle, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTerminalStore } from "@/store/terminalStore";
import { useShallow } from "zustand/react/shallow";

export const SOFT_TERMINAL_LIMIT = 50;
const WARNING_DISMISSED_KEY = "terminal-count-warning-dismissed";

interface TerminalCountWarningProps {
  className?: string;
  onOpenBulkActions?: () => void;
}

function shouldShowWarning(count: number): boolean {
  if (count <= SOFT_TERMINAL_LIMIT) return false;
  if (typeof window === "undefined") return false;
  try {
    const dismissed = sessionStorage.getItem(WARNING_DISMISSED_KEY);
    return dismissed !== "true";
  } catch {
    return true;
  }
}

function dismissWarning(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(WARNING_DISMISSED_KEY, "true");
  } catch {
    // Ignore storage errors
  }
}

export function TerminalCountWarning({ className, onOpenBulkActions }: TerminalCountWarningProps) {
  const { activeCount, completedCount } = useTerminalStore(
    useShallow((state) => {
      const activeTerminals = state.terminals.filter((t) => t.location !== "trash");
      const completedTerminals = activeTerminals.filter((t) => t.agentState === "completed");
      return {
        activeCount: activeTerminals.length,
        completedCount: completedTerminals.length,
      };
    })
  );

  const [isDismissed, setIsDismissed] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  const showWarning = !isDismissed && shouldShowWarning(activeCount);

  useEffect(() => {
    if (showWarning) {
      requestAnimationFrame(() => setIsVisible(true));
    } else {
      setIsVisible(false);
    }
  }, [showWarning]);

  const [dismissTimeoutId, setDismissTimeoutId] = useState<NodeJS.Timeout | null>(null);

  const handleDismiss = useCallback(() => {
    setIsVisible(false);
    const timeoutId = setTimeout(() => {
      dismissWarning();
      setIsDismissed(true);
    }, 200);
    setDismissTimeoutId(timeoutId);
  }, []);

  useEffect(() => {
    return () => {
      if (dismissTimeoutId) {
        clearTimeout(dismissTimeoutId);
      }
    };
  }, [dismissTimeoutId]);

  const handleCleanup = useCallback(() => {
    if (onOpenBulkActions) {
      onOpenBulkActions();
    } else {
      // Only close non-trashed completed terminals to match displayed count
      const terminals = useTerminalStore.getState().terminals;
      const completedNonTrashed = terminals.filter(
        (t) => t.agentState === "completed" && t.location !== "trash"
      );
      completedNonTrashed.forEach((t) => {
        useTerminalStore.getState().trashTerminal(t.id);
      });
    }
  }, [onOpenBulkActions]);

  if (!showWarning) return null;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 px-4 py-3 rounded-[var(--radius-lg)]",
        "bg-[color-mix(in_oklab,var(--color-status-warning)_12%,transparent)]",
        "border border-[var(--color-status-warning)]/30",
        "transition-all duration-200",
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2",
        className
      )}
      role="alert"
      aria-live="assertive"
    >
      <div className="flex items-center gap-3">
        <AlertTriangle className="h-5 w-5 text-[var(--color-status-warning)] shrink-0" />
        <div>
          <p className="text-sm font-medium text-[var(--color-status-warning)]">
            {activeCount} terminals open
          </p>
          <p className="text-xs text-canopy-text/70 mt-0.5">
            Consider closing idle terminals to keep the board light.
            {completedCount > 0 && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={handleCleanup}
                  className="underline hover:text-canopy-text transition-colors inline-flex items-center gap-1"
                >
                  <Trash2 className="h-3 w-3" />
                  Close {completedCount} completed agent{completedCount !== 1 ? "s" : ""}
                </button>
              </>
            )}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={handleDismiss}
        className={cn(
          "rounded-[var(--radius-sm)] p-1",
          "text-[var(--color-status-warning)]/60 transition-colors",
          "hover:text-[var(--color-status-warning)] hover:bg-[var(--color-status-warning)]/10",
          "focus:outline-none focus:ring-1 focus:ring-[var(--color-status-warning)]/50"
        )}
        aria-label="Dismiss warning"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export default TerminalCountWarning;
