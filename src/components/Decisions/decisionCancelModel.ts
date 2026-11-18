import type { DecisionQuestionCancelResult } from "@shared/types/decisionsQuestion";
import type { DecisionQuestionTarget } from "./decisionQuestionTarget";

/** The question a person asked to withdraw, as its row named it when they asked. */
export interface DecisionCancelTarget {
  /** One of a pane's, or one named by its reference (#17229): withdrawn the same way it was read. */
  question: DecisionQuestionTarget;
  /** `q-42`. */
  label: string;
  /** The opening line, when the row had read it. */
  line: string | null;
}

/**
 * What the dialog says after main answered, or after the call failed. `retry`
 * when asking again could change the outcome; otherwise the confirm stays
 * disabled and the dialog only closes.
 */
export interface DecisionCancelProblem {
  severity: "info" | "warning" | "error";
  message: string;
  retry: boolean;
}

export function cancelTitle(target: DecisionCancelTarget): string {
  return `Cancel question ${target.label}?`;
}

/** `queued`: the pane's state still lists it as not yet sent to the relay. */
export function cancelBody(queued: boolean): string {
  const where = queued
    ? "It hasn't been sent to your phones yet."
    : "It's withdrawn on every paired phone and leaves Needs you once the relay confirms.";
  return `${where} Nothing is typed into this terminal, and the agent sees the question cancelled when it checks.`;
}

/** Shown when the row stopped waiting while the dialog was open. */
export function noLongerWaiting(target: DecisionCancelTarget): DecisionCancelProblem {
  return {
    severity: "info",
    message: `${target.label} isn't waiting for an answer any more, so there's nothing to cancel.`,
    retry: false,
  };
}

/** Null when the cancel went through: dropped here, or committed for the relay to confirm. */
export function cancelProblem(
  target: DecisionCancelTarget,
  outcome: DecisionQuestionCancelResult
): DecisionCancelProblem | null {
  const { label } = target;
  switch (outcome.result) {
    case "cancelled":
    case "cancelling":
      return null;
    case "off":
      return {
        severity: "info",
        message: "Decisions is off for this terminal, so nothing was cancelled.",
        retry: false,
      };
    case "not-running":
      return {
        severity: "warning",
        message:
          "Decisions isn't running for this terminal right now, so nothing was cancelled. Try again once it's connected to its relay.",
        retry: true,
      };
    case "host-not-connected":
      return {
        severity: "warning",
        message:
          "The Remote Host that asked this question isn't connected, so it may not have been cancelled. Try again once it's back.",
        retry: true,
      };
    case "refused":
      switch (outcome.reason) {
        case "answered":
          return {
            severity: "info",
            message: `${label} has been answered, so it can't be cancelled.`,
            retry: false,
          };
        case "expired":
          return {
            severity: "info",
            message: `${label} has expired, so it can't be cancelled.`,
            retry: false,
          };
        case "publish-failed":
          return {
            severity: "info",
            message: `${label} never reached the relay, so there's nothing to withdraw.`,
            retry: false,
          };
        case "not-found":
          return {
            severity: "info",
            message: `${label} is no longer one of this terminal's questions.`,
            retry: false,
          };
      }
  }
}
