import { Suspense, lazy } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import type { DecisionsInboxDialogProps } from "./DecisionsInboxDialog";

const LazyDecisionsInboxDialog = lazy(() =>
  import("./DecisionsInboxDialog").then((m) => ({ default: m.DecisionsInboxDialog }))
);

/**
 * The view's Decisions inbox (#17231), mounted by the view rather than by
 * what opens it: a pane's chip goes once its last question settles, and the
 * inbox has to outlive it. Nothing loads until it is first opened. The
 * Canopy window mounts it too (#18048), with its own way to a terminal.
 */
export function DecisionsInboxHost({ goToTerminal }: DecisionsInboxDialogProps = {}) {
  const isOpen = useDecisionsInboxStore((state) => state.isOpen);
  const shouldMount = useKeepMounted(isOpen);
  return (
    <ErrorBoundary
      variant="component"
      componentName="DecisionsInboxDialog"
      resetKeys={[Number(isOpen)]}
    >
      {shouldMount && (
        <Suspense fallback={null}>
          <LazyDecisionsInboxDialog goToTerminal={goToTerminal} />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}
