import { useState, useEffect, useCallback, useRef } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { BANNER_ENTER_DURATION } from "@/lib/animationUtils";
import { usePanelStore } from "@/store/panelStore";
import { useShallow } from "zustand/react/shallow";
import { usePanelLimitStore, shouldShowSoftWarning } from "@/store/panelLimitStore";
import { InlineStatusBanner } from "./InlineStatusBanner";
import { requestPanelClose } from "@/services/terminal/optimisticPanelClose";
import { logError } from "@/utils/logger";

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
        if (t && t.location !== "trash" && t.ephemeral !== true) {
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

  const showWarning =
    !isDismissed &&
    shouldShowSoftWarning(activeCount, softLimit, warningsDisabled, lastDismissedAt);

  useEffect(() => {
    if (
      isDismissed &&
      shouldShowSoftWarning(activeCount, softLimit, warningsDisabled, lastDismissedAt)
    ) {
      setIsDismissed(false);
    }
  }, [activeCount, softLimit, warningsDisabled, lastDismissedAt, isDismissed]);

  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleDismiss = useCallback(() => {
    if (dismissTimeoutRef.current !== null) {
      clearTimeout(dismissTimeoutRef.current);
    }
    dismissTimeoutRef.current = setTimeout(() => {
      dismissTimeoutRef.current = null;
      dismissSoftWarning(activeCount);
      setIsDismissed(true);
    }, BANNER_ENTER_DURATION);
  }, [activeCount, dismissSoftWarning]);

  useEffect(() => {
    return () => {
      if (dismissTimeoutRef.current !== null) {
        clearTimeout(dismissTimeoutRef.current);
        dismissTimeoutRef.current = null;
      }
    };
  }, []);

  const handleCleanup = useCallback(() => {
    if (onOpenBulkActions) {
      onOpenBulkActions();
    } else {
      const { panelsById, panelIds } = usePanelStore.getState();
      const gridIds: string[] = [];
      const dockIds: string[] = [];

      for (const id of panelIds) {
        const t = panelsById[id];
        if (
          t &&
          (t.agentState === "completed" || t.agentState === "exited") &&
          t.location !== "trash" &&
          t.ephemeral !== true
        ) {
          if (t.location === "dock") {
            dockIds.push(t.id);
          } else {
            gridIds.push(t.id);
          }
        }
      }

      // Process dock panels immediately
      const trashPanel = usePanelStore.getState().trashPanel;
      for (const id of dockIds) {
        try {
          trashPanel(id);
        } catch (error) {
          logError("Failed to trash dock terminal pane from warning cleanup", error);
        }
      }

      // Process grid panels via optimistic close
      if (gridIds.length > 0) {
        requestPanelClose({
          hideIds: gridIds,
          commit: () => {
            const currentTrashPanel = usePanelStore.getState().trashPanel;
            for (const id of gridIds) {
              try {
                currentTrashPanel(id);
              } catch (error) {
                logError("Failed to trash grid terminal pane from warning cleanup", error);
              }
            }
          },
        });
      }
    }
  }, [onOpenBulkActions]);

  if (!showWarning) return null;

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title={`${activeCount} panels open`}
      description="Consider closing idle panels to keep the board light."
      descriptionExtras={
        completedCount > 0 ? (
          <button
            type="button"
            onClick={handleCleanup}
            className="mt-1 text-xs underline text-daintree-text/70 hover:text-daintree-text transition-colors inline-flex items-center gap-1 outline-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent rounded-sm"
          >
            <Trash2 className="h-3 w-3" />
            Close <span className="tabular-nums">{completedCount}</span> completed agent
            {completedCount !== 1 ? "s" : ""}
          </button>
        ) : undefined
      }
      severity="warning"
      role="status"
      ariaLive="polite"
      className={className}
      actions={[]}
      onClose={handleDismiss}
      closeAriaLabel="Dismiss warning"
    />
  );
}
