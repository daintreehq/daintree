import { Suspense, lazy } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";

const LazyDecisionQuestionDialog = lazy(() =>
  import("./DecisionQuestionDialog").then((m) => ({ default: m.DecisionQuestionDialog }))
);

/**
 * The view's Decisions question reader (#17098), mounted by the view rather
 * than by the pane's chip, which goes once its last question settles while
 * the question stays readable. Nothing loads until it is first opened.
 */
export function DecisionQuestionHost() {
  const isOpen = useDecisionsQuestionViewStore((state) => state.isOpen);
  const shouldMount = useKeepMounted(isOpen);
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
