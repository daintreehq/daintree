import { useEffect } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { usePanelLimitStore } from "@/store/panelLimitStore";

export function PanelLimitConfirmDialog() {
  const pendingConfirm = usePanelLimitStore((state) => state.pendingConfirm);
  const resolveConfirmation = usePanelLimitStore((state) => state.resolveConfirmation);

  // Resolve false on unmount to prevent leaked promises
  useEffect(() => {
    return () => {
      const pending = usePanelLimitStore.getState().pendingConfirm;
      if (pending) {
        pending.resolve(false);
      }
    };
  }, []);

  if (!pendingConfirm) return null;

  const { panelCount, memoryMB } = pendingConfirm;

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => resolveConfirmation(false)}
      title="Many panels open"
      description={`You currently have ${panelCount} panels open. Adding more may slow down the application.`}
      confirmLabel="Add Panel Anyway"
      cancelLabel="Cancel"
      onConfirm={() => resolveConfirmation(true)}
      variant="info"
    >
      {memoryMB != null && (
        <p className="text-xs text-canopy-text/60 tabular-nums">
          Current memory usage: {Math.round(memoryMB)} MB
        </p>
      )}
    </ConfirmDialog>
  );
}
