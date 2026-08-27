import { useState, useEffect, useCallback, useRef } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { BANNER_ENTER_DURATION } from "@/lib/animationUtils";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { countsTowardPanelLimit } from "@/store/slices/panelRegistry/panelCount";
import { useShallow } from "zustand/react/shallow";
import { usePanelLimitStore, shouldShowSoftWarning } from "@/store/panelLimitStore";
import { InlineStatusBanner } from "./InlineStatusBanner";
import { requestPanelClose } from "@/services/terminal/optimisticPanelClose";

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
        // Shared predicate so the banner's count matches the ceiling it warns
        // about — reading the ephemeral flag through a PTY narrowing here let a
        // non-PTY dialog panel inflate the count.
        if (!countsTowardPanelLimit(t)) continue;
        const pty = t && isPtyPanel(t) ? t : undefined;
        active++;
        if (pty?.agentState === "completed" || pty?.agentState === "exited") completed++;
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
      const idsToClose: string[] = [];
      for (const id of panelIds) {
        const t = panelsById[id];
        if (!t || !countsTowardPanelLimit(t)) continue;
        const pty = isPtyPanel(t) ? t : undefined;
        if (pty?.agentState === "completed" || pty?.agentState === "exited") {
          idsToClose.push(t.id);
        }
      }
      if (idsToClose.length === 0) return;
      requestPanelClose({
        hideIds: idsToClose,
        commit: () => {
          const latest = usePanelStore.getState();
          idsToClose.forEach((id) => latest.trashPanel(id));
        },
      });
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
            className="mt-1 text-xs underline text-daintree-text/70 hover:text-text-primary transition-colors inline-flex items-center gap-1 outline-hidden focus-visible:outline-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary rounded-sm"
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
