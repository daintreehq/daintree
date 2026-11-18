import { Suspense, lazy, useEffect } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { decisionsClient } from "@/clients/decisionsClient";
import { useDecisionsSwitch } from "@/hooks/useDecisionsOn";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import { useDecisionsAnswerStore } from "@/store/decisionsAnswerStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";

const LazyDecisionQuestionDialog = lazy(() =>
  import("./DecisionQuestionDialog").then((m) => ({ default: m.DecisionQuestionDialog }))
);

interface DecisionQuestionHostProps {
  /**
   * Opens the questions main sends this view, from a click on a question's
   * desktop notification (#17232) or a follow-up's (#17235). Only the app's
   * views take them.
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
  const decisionsSwitch = useDecisionsSwitch();
  const clearAnswers = useDecisionsAnswerStore((state) => state.clear);
  // Here rather than only in the dialog, which mounts at its first opening: a
  // dismissal from a pane's chip is kept, and followed, without it (#17239).
  // Only once Decisions is known to be off, so one being followed isn't
  // forgotten while main is still saying whether it's on.
  useEffect(() => {
    if (decisionsSwitch === "off") clearAnswers();
  }, [decisionsSwitch, clearAnswers]);
  useEffect(() => {
    if (!followsOpenRequests) return;
    return decisionsClient.onOpenQuestion((reference, messageId) =>
      useDecisionsQuestionViewStore.getState().openReference([reference], reference, messageId)
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
