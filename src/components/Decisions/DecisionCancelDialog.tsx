import { useState } from "react";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { decisionsClient } from "@/clients/decisionsClient";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  cancelBody,
  cancelProblem,
  cancelTitle,
  noLongerWaiting,
  type DecisionCancelProblem,
  type DecisionCancelTarget,
} from "./decisionCancelModel";

interface DecisionCancelDialogProps {
  /** The question asked about; kept while the dialog closes so its words don't blank mid-exit. */
  target: DecisionCancelTarget | null;
  isOpen: boolean;
  /** Whether the pane's state still lists the question as waiting for an answer. */
  waiting: boolean;
  onClose: () => void;
  /** Main committed the withdrawal and waits for the relay to confirm it. */
  onCancelling: (questionId: string) => void;
  restoreFocusTo: () => HTMLElement | null;
}

/**
 * Asks before a person withdraws one of a pane's questions (#17099): the
 * question by name and opening line, and what happens to it. Withdrawing
 * goes straight to main, not through an action, so the confirmation lives
 * here. A refusal stays in the dialog, naming the question.
 */
export function DecisionCancelDialog({
  target,
  isOpen,
  waiting,
  onClose,
  onCancelling,
  restoreFocusTo,
}: DecisionCancelDialogProps) {
  const [pending, setPending] = useState(false);
  const [answered, setAnswered] = useState<{
    target: DecisionCancelTarget;
    problem: DecisionCancelProblem;
  } | null>(null);
  const showSpinner = useDeferredLoading(pending, UI_DOHERTY_THRESHOLD);

  // An answer from main belongs to the ask it was about: each opening is a target of its own.
  const reported = target !== null && answered?.target === target ? answered.problem : null;
  const problem =
    reported ??
    (target !== null && isOpen && !pending && !waiting ? noLongerWaiting(target) : null);

  const confirm = async () => {
    if (target === null || pending) return;
    const asked = target;
    setPending(true);
    setAnswered(null);
    try {
      const outcome = await decisionsClient.cancelQuestion(asked.terminalId, asked.questionId);
      const refused = cancelProblem(asked, outcome);
      if (refused !== null) {
        setAnswered({ target: asked, problem: refused });
        return;
      }
      if (outcome.result === "cancelling") onCancelling(asked.questionId);
      onClose();
    } catch (error) {
      setAnswered({
        target: asked,
        problem: {
          severity: "error",
          message: formatErrorMessage(error, `Couldn't cancel ${asked.label}`),
          retry: true,
        },
      });
    } finally {
      setPending(false);
    }
  };

  const closed = problem !== null && !problem.retry;

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      variant="destructive"
      zIndex="nested"
      title={target === null ? "" : cancelTitle(target)}
      description={
        target === null ? undefined : (
          <span className="[text-wrap:pretty]">{cancelBody(target)}</span>
        )
      }
      confirmLabel="Cancel question"
      // Once nothing can be cancelled, the only answer left is to close.
      cancelLabel={closed ? "Close" : "Keep question"}
      confirmDisabled={closed}
      onConfirm={confirm}
      isConfirmLoading={showSpinner}
      isBusy={pending}
      restoreFocusTo={restoreFocusTo}
    >
      {target !== null && target.line !== null && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2 text-xs">
          <dt className="text-text-secondary">Question</dt>
          <dd className="min-w-0 break-words text-text-primary [text-wrap:pretty]">
            {target.line}
          </dd>
        </dl>
      )}
      {problem !== null && (
        <Callout
          severity={problem.severity}
          role={problem.severity === "error" ? "alert" : "status"}
        >
          {problem.message}
        </Callout>
      )}
    </ConfirmDialog>
  );
}
