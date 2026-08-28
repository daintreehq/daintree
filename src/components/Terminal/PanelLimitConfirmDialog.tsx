import { useEffect } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { usePanelLimitStore } from "@/store/panelLimitStore";

export function PanelLimitConfirmDialog() {
  const pendingConfirm = usePanelLimitStore((state) => state.pendingConfirm);
  const resolveConfirmation = usePanelLimitStore((state) => state.resolveConfirmation);
  // Reset on each new request. `requestSeq` (not a panelCount/memoryMB key)
  // covers back-to-back requests with identical params — the batch-preflight
  // path passes `memoryMB: null` every time, so a derived key wouldn't change
  // and a crashed boundary would stay stuck (#9918).
  const requestSeq = usePanelLimitStore((state) => state.requestSeq);

  // Resolve false on unmount to prevent leaked promises
  useEffect(() => {
    return () => {
      if (usePanelLimitStore.getState().pendingConfirm) {
        usePanelLimitStore.getState().resolveConfirmation(false);
      }
    };
  }, []);

  if (!pendingConfirm) return null;

  const { panelCount, memoryMB } = pendingConfirm;

  return (
    <ErrorBoundary
      variant="component"
      componentName="PanelLimitConfirmDialog"
      resetKeys={[requestSeq]}
    >
      <ConfirmDialog
        isOpen={true}
        onClose={() => resolveConfirmation(false)}
        title="Many panels open"
        description={`You currently have ${panelCount} panels open. Adding more may slow down the application.`}
        confirmLabel="Add panel anyway"
        cancelLabel="Cancel"
        onConfirm={() => resolveConfirmation(true)}
        variant="info"
      >
        {memoryMB != null && (
          <p className="text-xs text-text-secondary tabular-nums">
            Current memory usage: {Math.round(memoryMB)} MB
          </p>
        )}
      </ConfirmDialog>
    </ErrorBoundary>
  );
}
