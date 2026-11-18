import type { DeclinePhase } from "@/store/decisionsAnswerStore";
import type {
  DecisionQuestionCancelResult,
  DecisionQuestionStatus,
} from "@shared/types/decisionsQuestion";
import type { DismissAttempt } from "./decisionDeclineSend";
import type { DecisionQuestionTarget } from "./decisionQuestionTarget";

/** The question a person asked to dismiss or withdraw, as its row named it when they asked. */
export interface DecisionCancelTarget {
  /** One of a pane's, or one named by its reference (#17229): dismissed or withdrawn the same way it was read. */
  question: DecisionQuestionTarget;
  /** `q-42`. */
  label: string;
  /** The opening line, when the row had read it. */
  line: string | null;
  /**
   * The revision the person read it at, in the question view: a dismissal is
   * signed against it and never a later one. Null from a row that names the
   * question only by alias, which dismisses it as it is open now.
   */
  revision: number | null;
}

/**
 * The person's two ways to close a waiting question (#17239): `dismiss`
 * declines it for them, as a phone's Dismiss does, and is what they're
 * offered; `withdraw` calls it off as the desktop, as an agent's
 * `cancel_question` does, offered only where a dismissal can't be taken.
 */
export type DecisionCancelMode = "dismiss" | "withdraw";

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

export function dismissTitle(target: DecisionCancelTarget): string {
  return `Dismiss question ${target.label}?`;
}

export function dismissBody(): string {
  return "It's declined for you, as Dismiss on your phone does: if the agent that asked is still listening, it's told you chose not to answer, and nothing is decided or approved. Your phones show it declined on this computer, and it leaves Needs you.";
}

export function cancelTitle(target: DecisionCancelTarget): string {
  return `Withdraw question ${target.label}?`;
}

/** `queued`: the pane's state still lists it as not yet sent to the relay. */
export function cancelBody(queued: boolean): string {
  const where = queued
    ? "It hasn't been sent to your phones yet."
    : "It's withdrawn on every paired phone and leaves Needs you once the relay confirms.";
  return `${where} Nothing is typed into this terminal, and the agent sees the question cancelled when it checks.`;
}

/** Shown when the row stopped waiting while the dialog was open. */
export function noLongerWaiting(
  target: DecisionCancelTarget,
  mode: DecisionCancelMode = "withdraw"
): DecisionCancelProblem {
  const verb = mode === "dismiss" ? "dismiss" : "withdraw";
  return {
    severity: "info",
    message: `${target.label} isn't waiting for an answer any more, so there's nothing to ${verb}.`,
    retry: false,
  };
}

/**
 * Why a dismissal from this computer can't be taken where withdrawing still
 * can: the relay or the computer that asked doesn't take one yet, this
 * computer doesn't sign for the person, or the relay doesn't hold the
 * question yet (a Remote Host hasn't sent it). Null for any other phase.
 * Given the question's `status` as read now, a relay that didn't hold it
 * stops being a reason once it reads as sent: it can be dismissed again.
 */
export function dismissFallback(
  label: string,
  phase: DeclinePhase,
  status?: DecisionQuestionStatus
): string | null {
  const instead = "You can withdraw it instead.";
  if (phase.kind === "refused" && phase.reason === "not-owner") {
    return `This computer doesn't sign for you, so ${label} can't be dismissed here. Dismiss it on your phone, or withdraw it instead.`;
  }
  if (phase.kind !== "settled") return null;
  const outcome = phase.outcome;
  if (outcome.status === "unsupported") {
    return outcome.by === "relay"
      ? `Your relay needs an update before it takes a dismissal from this computer, so ${label} wasn't dismissed. ${instead}`
      : `Daintree on the computer that asked ${label} needs an update before it takes a dismissal from this computer, so it wasn't dismissed. ${instead}`;
  }
  if (
    outcome.status === "closed" &&
    outcome.reason === "not-found" &&
    (status === undefined || status === "queued")
  ) {
    return `The relay doesn't hold ${label} yet, so it wasn't dismissed. ${instead}`;
  }
  return null;
}

/**
 * How far a dismissal from here has got, while it's under way or once the
 * relay took it and the question hasn't closed here yet; null otherwise.
 */
export function dismissProgressText(phase: DeclinePhase): string | null {
  switch (phase.kind) {
    case "sending":
      return "Dismissing…";
    case "checking":
      return "Checking whether it was dismissed…";
    case "lost":
      return "Couldn't confirm whether it was dismissed.";
    case "refused":
      return null;
    case "settled":
      if (phase.outcome.status === "queued") {
        return "Dismissal queued. It's sent once the relay can be reached.";
      }
      return phase.outcome.status === "declined"
        ? "Dismissed. Waiting for it to close here…"
        : null;
  }
}

/**
 * What the dialog does with a Dismiss: `done` once it's taken or queued (the
 * question closes on its own), `withdraw` to offer withdrawing instead, with
 * why, or a `problem` to show.
 */
export type DismissVerdict =
  | { kind: "done"; key: string }
  | { kind: "withdraw"; message: string }
  | { kind: "problem"; problem: DecisionCancelProblem };

function problem(
  severity: DecisionCancelProblem["severity"],
  message: string,
  retry: boolean
): DismissVerdict {
  return { kind: "problem", problem: { severity, message, retry } };
}

/** A Dismiss that stopped before anything was signed, because the question couldn't be read again. */
function failedVerdict(
  label: string,
  reason: Extract<DismissAttempt, { kind: "failed" }>["reason"]
): DismissVerdict {
  switch (reason) {
    case "not-running":
      return problem(
        "warning",
        `Decisions isn't connected to its relay right now, so ${label} wasn't dismissed. Try again once it's connected.`,
        true
      );
    case "off":
      return problem("info", `Decisions is off, so ${label} wasn't dismissed.`, false);
    case "host-not-connected":
      return problem(
        "warning",
        `The Remote Host that asked ${label} isn't connected, so it wasn't dismissed. Try again once it's back.`,
        true
      );
    case "unreadable":
      return problem(
        "info",
        `${label} couldn't be opened on this computer, so it wasn't dismissed.`,
        false
      );
    case "failed":
      return problem("error", `${label} couldn't be read again, so it wasn't dismissed.`, true);
  }
}

export function dismissVerdict(
  target: DecisionCancelTarget,
  attempt: DismissAttempt
): DismissVerdict {
  const { label } = target;
  // A view that read a revision shows the update itself; a row's Dismiss reads it again.
  const changed = problem(
    "info",
    target.revision === null
      ? `${label} changed before it was dismissed. Try again to dismiss it as it is now.`
      : `${label} changed since you opened it, so it wasn't dismissed. Review it, then dismiss it again.`,
    target.revision === null
  );
  switch (attempt.kind) {
    case "failed":
      return failedVerdict(label, attempt.reason);
    case "gone":
      return { kind: "problem", problem: noLongerWaiting(target, "dismiss") };
    case "changed":
      return changed;
    case "busy":
      return problem(
        "info",
        `An answer to ${label} from this computer is under way, so it can't be dismissed.`,
        false
      );
    case "submitted":
      break;
  }
  const { phase } = attempt;
  const fallback = dismissFallback(label, phase);
  if (fallback !== null) return { kind: "withdraw", message: fallback };
  switch (phase.kind) {
    case "sending":
    case "checking":
      return { kind: "done", key: attempt.key };
    case "lost":
      return problem(
        "warning",
        `Couldn't confirm whether ${label} was dismissed. Try again to check.`,
        true
      );
    case "refused":
      switch (phase.reason) {
        case "off":
          return problem("info", `Decisions is off, so ${label} wasn't dismissed.`, false);
        case "invalid":
          return problem("error", `This computer couldn't sign a dismissal of ${label}.`, true);
        default:
          return problem("info", `${label} is no longer one of this terminal's questions.`, false);
      }
    case "settled":
      break;
  }
  const outcome = phase.outcome;
  switch (outcome.status) {
    case "queued":
    case "declined":
      return { kind: "done", key: attempt.key };
    case "already-answered":
      return problem("info", `${label} was answered first, so it wasn't dismissed.`, false);
    case "changed":
      return changed;
    case "closed":
      return problem(
        "info",
        outcome.reason === "expired"
          ? `${label} expired first, so it wasn't dismissed.`
          : `${label} was withdrawn or dismissed first.`,
        false
      );
    case "unsupported":
      // Answered by `dismissFallback` above.
      return problem("info", `${label} wasn't dismissed.`, false);
    case "rejected":
      return problem(
        "error",
        `The relay refused the dismissal of ${label} (${outcome.code}).`,
        true
      );
  }
}

/** Null when the withdrawal went through: dropped here, or committed for the relay to confirm. */
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
        message: "Decisions is off for this terminal, so nothing was withdrawn.",
        retry: false,
      };
    case "not-running":
      return {
        severity: "warning",
        message:
          "Decisions isn't running for this terminal right now, so nothing was withdrawn. Try again once it's connected to its relay.",
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
            message: `${label} has been answered, so it can't be withdrawn.`,
            retry: false,
          };
        case "expired":
          return {
            severity: "info",
            message: `${label} has expired, so it can't be withdrawn.`,
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

/**
 * Why a dismissal from here ended without being taken, once it settled out
 * of the dialog (a queued one read again, or a Retry), for the view to say
 * beside Dismiss; null while it's under way, once taken, and where
 * withdrawing is offered instead.
 */
export function dismissOutcomeText(
  target: DecisionCancelTarget,
  phase: DeclinePhase
): string | null {
  if (phase.kind !== "settled" && phase.kind !== "refused") return null;
  const verdict = dismissVerdict(target, { kind: "submitted", key: "", phase });
  return verdict.kind === "problem" ? verdict.problem.message : null;
}
