import { Suspense, lazy, useEffect } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { decisionsClient } from "@/clients/decisionsClient";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";

const LazyDecisionsAttentionDialog = lazy(() =>
  import("./DecisionsAttentionDialog").then((m) => ({
    default: m.DecisionsAttentionDialog,
  }))
);

interface DecisionsAttentionHostProps {
  /**
   * Opens the list when main asks this view to, from a click on a stalled
   * answer's desktop notification (#17235). Only the app's views take them.
   */
  followsOpenRequests?: boolean;
}

/**
 * The view's needs-attention list, mounted by the view itself rather than by
 * what opens it: a pane's chip and a Canopy run's notice both go once their
 * last answer is dealt with, and the list has to outlive them. Nothing loads
 * until the list is first opened.
 */
export function DecisionsAttentionHost({
  followsOpenRequests = false,
}: DecisionsAttentionHostProps) {
  const isOpen = useDecisionsAttentionStore((state) => state.isOpen);
  const close = useDecisionsAttentionStore((state) => state.close);
  const shouldMount = useKeepMounted(isOpen);
  useEffect(() => {
    if (!followsOpenRequests) return;
    return decisionsClient.onOpenAttention((terminalId) =>
      useDecisionsAttentionStore.getState().open(terminalId)
    );
  }, [followsOpenRequests]);
  return (
    <ErrorBoundary
      variant="component"
      componentName="DecisionsAttentionDialog"
      resetKeys={[Number(isOpen)]}
    >
      {shouldMount && (
        <Suspense fallback={null}>
          <LazyDecisionsAttentionDialog isOpen={isOpen} onClose={close} />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}
