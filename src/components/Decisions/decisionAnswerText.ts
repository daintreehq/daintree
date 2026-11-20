import type { AnswerHold, AnswerPhase, AnswerRefusal } from "@/store/decisionsAnswerStore";
import type {
  DecisionAnswerOutcome,
  DecisionQuestionContent,
  DecisionQuestionStatus,
} from "@shared/types/decisionsQuestion";

/**
 * What the composer says about an answer from this computer (#17102): only
 * what main or the relay reported, and whether anything was sent.
 */

const PHONE = "Your phone can still answer it.";

/** Why a question stopped taking answers while a person was writing one. */
export function closedText(status: DecisionQuestionStatus): string {
  switch (status) {
    case "human-answered":
      return "This question was answered elsewhere, so your answer wasn't sent.";
    case "proxy-answered":
      return "The decision model answered this question, so your answer wasn't sent.";
    case "cancelled":
      return "This question was cancelled, so your answer wasn't sent.";
    case "publish-failed":
      return "This question couldn't be sent, so it can't be answered.";
    // An open one past its time: the store records the expiry once the relay does.
    default:
      return "This question expired, so your answer wasn't sent.";
  }
}

/** An outcome that leaves nothing taken, or null for one that was taken or is being sent. */
export function outcomeText(outcome: DecisionAnswerOutcome): string | null {
  switch (outcome.status) {
    case "queued":
    case "sent":
      return null;
    case "already-answered":
      return "This question was answered elsewhere first, so your answer wasn't taken.";
    case "changed":
      return "This question changed before your answer reached it, so it wasn't taken. Review the update and send again.";
    case "closed":
      return outcome.reason === "expired"
        ? "This question expired before your answer reached it, so it wasn't taken."
        : outcome.reason === "cancelled"
          ? "This question was cancelled before your answer reached it, so it wasn't taken."
          : "The relay no longer holds this question, so your answer wasn't taken.";
    case "unsupported":
      return outcome.by === "relay"
        ? `Your relay needs an update before it takes answers from this computer. ${PHONE}`
        : `Daintree on the computer that asked needs an update before it takes answers from this computer. ${PHONE}`;
    case "rejected":
      return `The relay refused this answer. ${PHONE}`;
  }
}

const REFUSALS: Record<AnswerRefusal, string> = {
  "not-owner": `This computer doesn't sign answers for you, so nothing was sent. ${PHONE}`,
  "not-found": `This question can't be answered from this computer, so nothing was sent. ${PHONE}`,
  unreadable: `This question couldn't be opened on this computer, so nothing was sent. ${PHONE}`,
  invalid: "The answer doesn't fit what the question allows, so nothing was sent.",
  off: "Decisions is off, so nothing was sent.",
};

export function refusalText(reason: AnswerRefusal): string {
  return REFUSALS[reason];
}

const HOLDS: Record<AnswerHold, string> = {
  closed: "This question no longer takes an answer, so nothing was sent.",
  changed: "This question changed, so nothing was sent. Review it and send again.",
  unreadable: "This question couldn't be read again before sending, so nothing was sent.",
  "not-running":
    "Decisions isn't connected to its relay right now, so nothing was sent. Reconnect it in Settings → Decisions.",
  failed: "This question couldn't be read again before sending, so nothing was sent.",
};

/** Why a Send stopped before anything was signed. */
export function holdText(hold: AnswerHold): string {
  return HOLDS[hold];
}

/** A failed attempt's words, while the person may send again; null for one taken or under way. */
export function attemptText(phase: AnswerPhase): string | null {
  if (phase.kind === "refused") return refusalText(phase.reason);
  if (phase.kind === "settled") return outcomeText(phase.outcome);
  return null;
}

/**
 * How far an answer from this computer has got: sending, queued, taken by
 * the relay, and then typed into the asking terminal, as the question's own
 * record shows once its thread holds this answer.
 */
export function progressText(
  phase: AnswerPhase,
  question: DecisionQuestionContent,
  answerId: string
): string {
  const answers = question.thread.filter((entry) => entry.type === "answer");
  const mine = answers.find((entry) => entry.entryId === answerId);
  if (mine !== undefined) {
    // Its own delivery first (#17943): a later correction's doesn't say what happened to this one.
    if (mine.delivered === true) return "Answer sent and typed into the terminal";
    if (mine !== answers.at(-1) && mine.delivered === false) {
      return "Answer sent. A later answer came after it, and typing this one in wasn't confirmed.";
    }
    switch (question.deliveryStatus) {
      case "terminal-delivered":
        return "Answer sent and typed into the terminal";
      case "pending-host":
        return "Answer sent. It's typed in once this terminal's host is back.";
      case "needs-attention":
        return "Answer sent, but it couldn't be typed in. Review it from the terminal's Decisions menu.";
      case "delivery-uncertain":
        return "Answer sent. It may or may not have been typed in.";
      default:
        return "Answer sent. Waiting for it to be typed into the terminal…";
    }
  }
  switch (phase.kind) {
    case "sending":
      return "Sending your answer…";
    case "checking":
      return "Checking whether your answer was sent…";
    case "lost":
      return "Couldn't confirm whether your answer was sent.";
    default:
      return phase.kind === "settled" && phase.outcome.status === "queued"
        ? "Answer queued. It's sent once the relay can be reached."
        : "Answer sent";
  }
}
