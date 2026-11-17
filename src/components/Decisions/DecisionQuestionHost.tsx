import { Suspense, lazy, useEffect } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { decisionsClient } from "@/clients/decisionsClient";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";

const LazyDecisionQuestionDialog = lazy(() =>
  import("./DecisionQuestionDialog").then((m) => ({ default: m.DecisionQuestionDialog }))
);

interface DecisionQuestionHostProps {
  /**
   * Opens the questions main sends this view, from a click on a question's
   * desktop notification (#17232). Only the app's views take them.
   */
  followsOpenRequests?: boolean;
}

/**
 * The view's Decisions question reader (#17098), mounted by the view rather
 * than by the pane's chip, which goes once its last question settles while
 * the question stays readable. Nothing loads until it is first opened.
 */
export function DecisionQuestionHost({ followsOpenRequests = false }: DecisionQuestionHostProps) {
  const isOpen = useDecisionsQuestionViewStore((state) => state.isOpen);
  const shouldMount = useKeepMounted(isOpen);
  useEffect(() => {
    if (!followsOpenRequests) return;
    return decisionsClient.onOpenQuestion((reference) =>
      useDecisionsQuestionViewStore.getState().openReference([reference], reference)
    );
  }, [followsOpenRequests]);
  return (
    <ErrorBoundary
      variant="component"
      componentName="DecisionQuestionDialog"
      resetKeys={[Number(isOpen)]}
    >
      {shouldMount && (
        <Suspense fallback={null}>
          <LazyDecisionQuestionDialog />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}
