import { useEffect, useState } from "react";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  cancelBody,
  cancelProblem,
  cancelTitle,
  dismissBody,
  dismissTitle,
  dismissVerdict,
  noLongerWaiting,
  type DecisionCancelMode,
  type DecisionCancelProblem,
  type DecisionCancelTarget,
} from "./decisionCancelModel";
import { dismissQuestion } from "./decisionDeclineSend";
import { cancelTarget, questionOf, readTargetLine } from "./decisionQuestionTarget";

/**
 * How long the withdrawal offered in place of a dismissal that can't be
 * taken stays unavailable: a second click of the Dismiss press that got the
 * refusal lands where Withdraw now is, and must not withdraw anything.
 */
const WITHDRAW_COOLDOWN_MS = 800;

interface DecisionCancelDialogProps {
  /** The question asked about; kept while the dialog closes so its words don't blank mid-exit. */
  target: DecisionCancelTarget | null;
  isOpen: boolean;
  /** What this opening asks first: a dismissal, or the withdrawal offered when one can't be taken. */
  mode?: DecisionCancelMode;
  /** Why a dismissal can't be taken, when the opening asks to withdraw for that reason. */
  reason?: string | null;
  /** Whether the pane's state still lists the question as waiting for an answer. */
  waiting: boolean;
  /** Whether the pane's state still lists it as not yet sent to the relay. */
  queued: boolean;
  onClose: () => void;
  /** Main committed the withdrawal and waits for the relay to confirm it. */
  onCancelling: (questionId: string) => void;
  /** The dismissal was taken or queued: the question closes once its asking computer records it. */
  onDismissing?: (questionId: string, key: string) => void;
  restoreFocusTo: () => HTMLElement | null;
}

/** What one opening has come to: the step it asks now, why, and what main last said. */
interface Asked {
  target: DecisionCancelTarget;
  mode: DecisionCancelMode;
  reason: string | null;
  problem: DecisionCancelProblem | null;
}

/**
 * Asks before a person dismisses one of a pane's questions (#17239): the
 * question by name and opening line, and what happens to it. A dismissal is
 * the person's decline, signed by this computer; where the relay or the
 * computer that asked can't take one, this computer can't sign for the
 * person, or the relay doesn't hold the question yet, it says so and asks
 * again, separately, to withdraw it instead, as the desktop (#17099). Both
 * go straight to main, not through an action, so the confirmation lives
 * here. A refusal stays in the dialog, naming the question.
 */
export function DecisionCancelDialog({
  target,
  isOpen,
  mode: openingMode = "dismiss",
  reason: openingReason = null,
  waiting,
  queued,
  onClose,
  onCancelling,
  onDismissing,
  restoreFocusTo,
}: DecisionCancelDialogProps) {
  const [pending, setPending] = useState(false);
  const [asked, setAsked] = useState<Asked | null>(null);
  // The opening line, read here when the row hadn't read it yet, so the
  // question is shown by its words before anything is dismissed.
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
    readTargetLine(target.question).then(
      settle,
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

  // What main said belongs to the opening it was about: each opening is a target of its own.
  const current = target !== null && asked?.target === target ? asked : null;
  const mode = current?.mode ?? openingMode;
  const reason = current !== null ? current.reason : openingReason;
  const reported = current?.problem ?? null;
  // A refusal stands; a call that failed gives way once the question has stopped waiting.
  const gone =
    target !== null && isOpen && !pending && !waiting ? noLongerWaiting(target, mode) : null;
  const problem = reported !== null && !reported.retry ? reported : (gone ?? reported);

  const confirm = async () => {
    if (target === null || pending || reading) return;
    const subject = target;
    const step = mode;
    const why = reason;
    const report = (next: Omit<Asked, "target">) => setAsked({ target: subject, ...next });
    setPending(true);
    report({ mode: step, reason: why, problem: null });
    try {
      if (step === "dismiss") {
        const verdict = dismissVerdict(
          subject,
          await dismissQuestion(subject.question, subject.revision)
        );
        switch (verdict.kind) {
          case "done":
            onDismissing?.(questionOf(subject.question).questionId, verdict.key);
            onClose();
            return;
          case "withdraw":
            report({ mode: "withdraw", reason: verdict.message, problem: null });
            return;
          case "problem":
            report({ mode: step, reason: why, problem: verdict.problem });
            return;
        }
      }
      const outcome = await cancelTarget(subject.question);
      const refused = cancelProblem(subject, outcome);
      if (refused !== null) {
        report({ mode: step, reason: why, problem: refused });
        return;
      }
      if (outcome.result === "cancelling") onCancelling(questionOf(subject.question).questionId);
      onClose();
    } catch (error) {
      const verb = step === "dismiss" ? "dismiss" : "withdraw";
      report({
        mode: step,
        reason: why,
        problem: {
          severity: "error",
          message: formatErrorMessage(error, `Couldn't ${verb} ${subject.label}`),
          retry: true,
        },
      });
    } finally {
      setPending(false);
    }
  };

  const closed = problem !== null && !problem.retry;
  const dismissing = mode === "dismiss";

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      variant="destructive"
      zIndex="nested"
      title={target === null ? "" : dismissing ? dismissTitle(target) : cancelTitle(target)}
      description={
        target === null ? undefined : (
          <span className="[text-wrap:pretty]">
            {dismissing ? dismissBody() : cancelBody(queued)}
          </span>
        )
      }
      confirmLabel={dismissing ? "Dismiss question" : "Withdraw question"}
      // Once nothing can be done, the only answer left is to close.
      cancelLabel={closed ? "Close" : "Keep question"}
      confirmDisabled={closed || reading}
      // A withdrawal offered in place of a dismissal starts again from Keep question.
      focusResetKey={mode}
      cooldownKey={mode}
      confirmCooldownMs={!dismissing && current?.reason != null ? WITHDRAW_COOLDOWN_MS : undefined}
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
      {!dismissing && reason !== null && problem === null && (
        <Callout severity="info" role="status" data-testid="decision-cancel-reason">
          {reason}
        </Callout>
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
