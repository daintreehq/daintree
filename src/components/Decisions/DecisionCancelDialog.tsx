import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DeclinePhase } from "@/store/decisionsAnswerStore";
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
  dismissFallback,
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
  /** The dismissal that couldn't be taken, when the opening asks to withdraw because of it. */
  fallback?: DeclinePhase | null;
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
  /** The dismissal that couldn't be taken, which withdrawing is offered for. */
  fallback: DeclinePhase | null;
  problem: DecisionCancelProblem | null;
  /** Where its last dismissal is kept, so trying again reads that one by its id first. */
  key: string | null;
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
  fallback: openingFallback = null,
  waiting,
  queued,
  onClose,
  onCancelling,
  onDismissing,
  restoreFocusTo,
}: DecisionCancelDialogProps) {
  // The opening whose confirm is with main: it alone is locked, and only it closes when main answers.
  const [busyFor, setBusyFor] = useState<DecisionCancelTarget | null>(null);
  const [asked, setAsked] = useState<Asked | null>(null);
  // The opening on screen, as of the last commit: a layout effect, so no reply from main lands in between.
  const shown = useRef<DecisionCancelTarget | null>(null);
  useLayoutEffect(() => {
    shown.current = isOpen ? target : null;
  });
  const pending = busyFor !== null && busyFor === target;
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
  const fallback = current !== null ? current.fallback : openingFallback;
  // Withdrawing is offered only while the reason still holds: a question the
  // relay didn't hold yet can be dismissed once it has been sent.
  const reason =
    target !== null && fallback !== null
      ? dismissFallback(target.label, fallback, queued ? "queued" : "open")
      : null;
  const mode: DecisionCancelMode =
    (current?.mode ?? openingMode) === "withdraw" && reason !== null ? "withdraw" : "dismiss";
  // A problem belongs to the step that met it: a withdrawal's never shows under a Dismiss.
  const reported = current !== null && current.mode === mode ? current.problem : null;
  // A refusal stands; a call that failed gives way once the question has stopped waiting.
  const gone =
    target !== null && isOpen && !pending && !waiting ? noLongerWaiting(target, mode) : null;
  const problem = reported !== null && !reported.retry ? reported : (gone ?? reported);

  const confirm = async () => {
    if (target === null || pending || reading) return;
    const subject = target;
    const step = mode;
    const because = fallback;
    let key = current?.key ?? null;
    // A late answer for an opening since replaced never overwrites the newer one's state.
    const report = (next: Omit<Asked, "target" | "key">) =>
      setAsked((prev) =>
        prev !== null && prev.target !== subject && shown.current !== subject
          ? prev
          : { target: subject, key, ...next }
      );
    // Main's answer closes only the opening it was for, never one opened since.
    const close = () => {
      if (shown.current === subject) onClose();
    };
    const dismiss = async () => {
      const attempt = await dismissQuestion(subject.question, subject.revision, key);
      if (attempt.kind === "submitted") key = attempt.key;
      const verdict = dismissVerdict(subject, attempt);
      switch (verdict.kind) {
        case "done":
          onDismissing?.(questionOf(subject.question).questionId, verdict.key);
          close();
          return;
        case "withdraw":
          report({
            mode: "withdraw",
            fallback: attempt.kind === "submitted" ? attempt.phase : null,
            problem: null,
          });
          return;
        case "problem":
          report({ mode: step, fallback: because, problem: verdict.problem });
          return;
      }
    };
    const withdraw = async () => {
      const outcome = await cancelTarget(subject.question);
      const refused = cancelProblem(subject, outcome);
      if (refused !== null) {
        report({ mode: step, fallback: because, problem: refused });
        return;
      }
      if (outcome.result === "cancelling") onCancelling(questionOf(subject.question).questionId);
      close();
    };
    setBusyFor(subject);
    // Chained rather than try/finally, which the React Compiler can't compile.
    await Promise.resolve()
      .then(() => {
        report({ mode: step, fallback: because, problem: null });
        return step === "dismiss" ? dismiss() : withdraw();
      })
      .catch((error: unknown) => {
        const verb = step === "dismiss" ? "dismiss" : "withdraw";
        report({
          mode: step,
          fallback: because,
          problem: {
            severity: "error",
            message: formatErrorMessage(error, `Couldn't ${verb} ${subject.label}`),
            retry: true,
          },
        });
      })
      .finally(() => setBusyFor((locked) => (locked === subject ? null : locked)));
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
      confirmCooldownMs={
        !dismissing && current !== null && current.fallback !== null
          ? WITHDRAW_COOLDOWN_MS
          : undefined
      }
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
