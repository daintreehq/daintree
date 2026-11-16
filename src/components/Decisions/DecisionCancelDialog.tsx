import { useEffect, useState } from "react";
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
  /** Whether the pane's state still lists it as not yet sent to the relay. */
  queued: boolean;
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
  queued,
  onClose,
  onCancelling,
  restoreFocusTo,
}: DecisionCancelDialogProps) {
  const [pending, setPending] = useState(false);
  const [answered, setAnswered] = useState<{
    target: DecisionCancelTarget;
    problem: DecisionCancelProblem;
  } | null>(null);
  // The opening line, read here when the row hadn't read it yet, so the
  // question is shown by its words before anything is withdrawn.
  const [read, setRead] = useState<{ target: DecisionCancelTarget; line: string | null } | null>(
    null
  );
  const showSpinner = useDeferredLoading(pending, UI_DOHERTY_THRESHOLD);

  useEffect(() => {
    if (!isOpen || target === null || target.line !== null) return;
    let live = true;
    const settle = (line: string | null) => {
      if (live) setRead({ target, line });
    };
    decisionsClient.getQuestionSummaries(target.terminalId, [target.questionId]).then(
      (result) => {
        const summary =
          result.result === "read"
            ? result.summaries.find((candidate) => candidate.questionId === target.questionId)
            : undefined;
        settle(summary?.result === "read" ? summary.line : null);
      },
      // A question whose words can't be read here is named by alias alone.
      () => settle(null)
    );
    return () => {
      live = false;
    };
  }, [isOpen, target]);

  const line = target?.line ?? (read !== null && read.target === target ? read.line : null);
  const reading = isOpen && target !== null && target.line === null && read?.target !== target;
  const showReading = useDeferredLoading(reading, UI_DOHERTY_THRESHOLD);

  // An answer from main belongs to the ask it was about: each opening is a target of its own.
  const reported = target !== null && answered?.target === target ? answered.problem : null;
  // A refusal stands; a call that failed gives way once the question has stopped waiting.
  const gone = target !== null && isOpen && !pending && !waiting ? noLongerWaiting(target) : null;
  const problem = reported !== null && !reported.retry ? reported : (gone ?? reported);

  const confirm = async () => {
    if (target === null || pending || reading) return;
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
          <span className="[text-wrap:pretty]">{cancelBody(queued)}</span>
        )
      }
      confirmLabel="Cancel question"
      // Once nothing can be cancelled, the only answer left is to close.
      cancelLabel={closed ? "Close" : "Keep question"}
      confirmDisabled={closed || reading}
      hint={showReading ? "Reading the question…" : undefined}
      onConfirm={confirm}
      isConfirmLoading={showSpinner}
      isBusy={pending}
      restoreFocusTo={restoreFocusTo}
    >
      {target !== null && line !== null && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2 text-xs">
          <dt className="text-text-secondary">Question</dt>
          <dd className="min-w-0 break-words text-text-primary [text-wrap:pretty]">{line}</dd>
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
