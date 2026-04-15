import { useState, useEffect, useCallback } from "react";
import { X, AlertTriangle, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import { useShallow } from "zustand/react/shallow";
import { usePanelLimitStore, shouldShowSoftWarning } from "@/store/panelLimitStore";

interface TerminalCountWarningProps {
  className?: string;
  onOpenBulkActions?: () => void;
}

export function TerminalCountWarning({ className, onOpenBulkActions }: TerminalCountWarningProps) {
  const { activeCount, completedCount } = usePanelStore(
    useShallow((state) => {
      let active = 0;
      let completed = 0;
      for (const id of state.panelIds) {
        const t = state.panelsById[id];
        if (t && t.location !== "trash") {
          active++;
          if (t.agentState === "completed" || t.agentState === "exited") completed++;
        }
      }
      return { activeCount: active, completedCount: completed };
    })
  );

  const softLimit = usePanelLimitStore((state) => state.softWarningLimit);
  const warningsDisabled = usePanelLimitStore((state) => state.warningsDisabled);
  const lastDismissedAt = usePanelLimitStore((state) => state.lastSoftWarningDismissedAt);
  const dismissSoftWarning = usePanelLimitStore((state) => state.dismissSoftWarning);
  const initializeFromHardware = usePanelLimitStore((state) => state.initializeFromHardware);

  useEffect(() => {
    void initializeFromHardware();
  }, [initializeFromHardware]);

  const [isDismissed, setIsDismissed] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  const showWarning =
    !isDismissed &&
    shouldShowSoftWarning(activeCount, softLimit, warningsDisabled, lastDismissedAt);

  useEffect(() => {
    if (showWarning) {
      requestAnimationFrame(() => setIsVisible(true));
    } else {
      setIsVisible(false);
    }
  }, [showWarning]);

  useEffect(() => {
    if (
      isDismissed &&
      shouldShowSoftWarning(activeCount, softLimit, warningsDisabled, lastDismissedAt)
    ) {
      setIsDismissed(false);
    }
  }, [activeCount, softLimit, warningsDisabled, lastDismissedAt, isDismissed]);

  const [dismissTimeoutId, setDismissTimeoutId] = useState<NodeJS.Timeout | null>(null);

  const handleDismiss = useCallback(() => {
    setIsVisible(false);
    const timeoutId = setTimeout(() => {
      dismissSoftWarning(activeCount);
      setIsDismissed(true);
    }, 200);
    setDismissTimeoutId(timeoutId);
  }, [activeCount, dismissSoftWarning]);

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
      const { panelsById, panelIds } = usePanelStore.getState();
      for (const id of panelIds) {
        const t = panelsById[id];
        if (
          t &&
          (t.agentState === "completed" || t.agentState === "exited") &&
          t.location !== "trash"
        ) {
          usePanelStore.getState().trashPanel(t.id);
        }
      }
    }
  }, [onOpenBulkActions]);

  if (!showWarning) return null;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 px-4 py-3 rounded-[var(--radius-lg)]",
        "bg-[color-mix(in_oklab,var(--color-status-warning)_12%,transparent)]",
        "border border-status-warning/30",
        "transition duration-200",
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2",
        className
      )}
      role="alert"
      aria-live="assertive"
    >
      <div className="flex items-center gap-3">
        <AlertTriangle className="h-5 w-5 text-status-warning shrink-0" />
        <div>
          <p className="text-sm font-medium tabular-nums text-status-warning">
            {activeCount} panels open
          </p>
          <p className="text-xs text-daintree-text/70 mt-0.5">
            Consider closing idle panels to keep the board light.
            {completedCount > 0 && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={handleCleanup}
                  className="underline hover:text-daintree-text transition-colors inline-flex items-center gap-1"
                >
                  <Trash2 className="h-3 w-3" />
                  Close <span className="tabular-nums">{completedCount}</span> completed agent
                  {completedCount !== 1 ? "s" : ""}
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
          "text-status-warning/60 transition-colors",
          "hover:text-status-warning hover:bg-status-warning/10",
          "focus:outline-none focus:ring-1 focus:ring-status-warning/50"
        )}
        aria-label="Dismiss warning"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export default TerminalCountWarning;
