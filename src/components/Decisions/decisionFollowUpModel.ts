import type { FollowUpHold, FollowUpPhase, FollowUpRefusal } from "@/store/decisionsFollowUpStore";
import type {
  DecisionFollowUpOutcome,
  DecisionQuestionContent,
  DecisionQuestionListItem,
  DecisionThreadMessage,
} from "@shared/types/decisionsQuestion";
import { formatTextExcess, isAnswerable, textBytes } from "./decisionComposeModel";

/**
 * The person's follow-up on a question, written here (#17238): when it can
 * be sent, and what the view says about it, from only what main or the relay
 * reported.
 */

/** The protocol's bound on a message's words, in UTF-8 bytes (`LIMITS.messageTextBytes`). */
export const FOLLOW_UP_TEXT_BYTES = 16 * 1024;

/**
 * Whether the question still takes a follow-up from the person: before its
 * answer while it waits for one, and after it. A question not yet with the
 * relay, withdrawn, expired or never sent takes none.
 */
export function takesFollowUp(
  question: Pick<DecisionQuestionContent, "status" | "expiresAt">,
  nowMs: number
): boolean {
  switch (question.status) {
    case "human-answered":
    case "proxy-answered":
      return true;
    case "open":
      return isAnswerable(question, nowMs);
    default:
      return false;
  }
}

/**
 * Whether typing into the asking terminal stopped on this question and nobody
 * has resolved it (#18028), as this computer's list says of the same
 * question: a follow-up sent now would only wait behind what stopped. The
 * list's standing, never the question's own delivery status, which Mark
 * handled leaves as it was. Never a reason to drop a follow-up already on its
 * way: `takesFollowUp` alone decides that.
 */
export function deliveryStalled(
  question: Pick<DecisionQuestionContent, "reference">,
  listed: Pick<DecisionQuestionListItem, "reference" | "standing"> | null
): boolean {
  if (listed === null || listed.standing.kind !== "needs-attention") return false;
  return (
    listed.reference.hostId === question.reference.hostId &&
    listed.reference.questionId === question.reference.questionId
  );
}

/**
 * The agent's latest request for a reply, when nothing has answered it: a
 * follow-up sent now is the reply it waits for. Read along the thread as the
 * protocol reads it: the person's message or answer after the request
 * answers it, and a later message of the agent's replaces it. The model's
 * answer answers nothing.
 */
export function replyRequest(
  question: Pick<DecisionQuestionContent, "thread">
): DecisionThreadMessage | null {
  let request: DecisionThreadMessage | null = null;
  for (const entry of question.thread) {
    if (entry.type === "message") {
      request = entry.from === "agent" && entry.expectsReply ? entry : null;
    } else if (entry.type === "answer" && entry.from === "person") {
      request = null;
    }
  }
  return request;
}

/**
 * What declining a reply request sends (#18030): the person's own follow-up,
 * typed into the terminal that asked. Protocol 0.9.0 has no record of a
 * declined request, so a message is what ends the wait on every device.
 */
export const DECLINE_REPLY_TEXT = "I won't reply to this, so don't wait for a reply from me.";

/**
 * The agent's request for a reply that the person can decline (#18030): one
 * on an answered question, which nothing ends but the person's own message
 * or answer, or the agent's next message. An open question's is declined by
 * dismissing the question.
 */
export function declinableReplyRequest(
  question: Pick<DecisionQuestionContent, "status" | "thread">
): DecisionThreadMessage | null {
  if (question.status !== "human-answered" && question.status !== "proxy-answered") return null;
  return replyRequest(question);
}

export function declineReplyTitle(label: string): string {
  return `Decline to reply on ${label}?`;
}

/** What sending the decline does, everywhere it reaches; the message itself is shown beside it. */
export const DECLINE_REPLY_BODY =
  "This follow-up is sent as yours. Once the relay takes it, the question stops waiting for your reply here and on your phones, and your answer stays as it is. Daintree then types it into the terminal that asked. If that terminal has closed, Daintree may reopen the agent's session to type it in, or list the follow-up under Needs attention.";

export interface FollowUpVerdict {
  canSend: boolean;
  hint: string | null;
  textOver: number;
}

export function followUpVerdict(draft: string): FollowUpVerdict {
  const textOver = Math.max(0, textBytes(draft) - FOLLOW_UP_TEXT_BYTES);
  if (draft.trim().length === 0) return { canSend: false, hint: null, textOver };
  if (textOver > 0) {
    return {
      canSend: false,
      hint: `Shorten your follow-up by ${formatTextExcess(textOver)}`,
      textOver,
    };
  }
  return { canSend: true, hint: null, textOver };
}

/** An outcome that leaves nothing taken, or null for one that was taken or is being sent. */
export function followUpOutcomeText(outcome: DecisionFollowUpOutcome): string | null {
  switch (outcome.status) {
    case "queued":
    case "sent":
      return null;
    case "closed":
      return outcome.reason === "expired"
        ? "This question expired before your follow-up reached it, so it wasn't sent."
        : outcome.reason === "cancelled"
          ? "This question was closed before your follow-up reached it, so it wasn't sent."
          : "The relay no longer holds this question, so your follow-up wasn't sent.";
    // Never that a phone can still send one: the same outcome covers a relay or a computer without threads at all.
    case "unsupported":
      return outcome.by === "relay"
        ? "Your relay needs an update before it takes follow-ups from this computer, so nothing was sent."
        : "Daintree on the computer that asked needs an update before it takes follow-ups from this computer, so nothing was sent.";
    case "rejected":
      return `The relay refused this follow-up (${outcome.code}), so nothing was sent.`;
  }
}

const REFUSALS: Record<FollowUpRefusal, string> = {
  "not-owner": "This computer doesn't sign follow-ups for you, so nothing was sent.",
  "not-found": "This question can't be followed up from this computer, so nothing was sent.",
  invalid: "This follow-up doesn't fit what a message allows, so nothing was sent.",
  off: "Decisions is off, so nothing was sent.",
};

const HOLDS: Record<FollowUpHold, string> = {
  closed: "This question no longer takes follow-ups, so nothing was sent.",
  unreadable: "This question couldn't be read again before sending, so nothing was sent.",
  "not-running":
    "Decisions isn't connected to its relay right now, so nothing was sent. Reconnect it in Settings → Decisions.",
  failed: "This question couldn't be read again before sending, so nothing was sent.",
  "request-moved":
    "The agent's request for a reply was answered or replaced before this was sent, so nothing was sent. Review the thread first.",
};

/** Why a Send stopped before anything was signed. */
export function followUpHoldText(hold: FollowUpHold): string {
  return HOLDS[hold];
}

/** A failed attempt's words, while the person may send again; null for one taken or under way. */
export function followUpAttemptText(phase: FollowUpPhase): string | null {
  if (phase.kind === "refused") return REFUSALS[phase.reason];
  if (phase.kind === "settled") return followUpOutcomeText(phase.outcome);
  return null;
}

/**
 * How far a follow-up from this computer has got: sending, queued, taken by
 * the relay, and then typed into the asking terminal, as the question's own
 * thread shows once it holds this message. Null once it failed.
 */
export function followUpProgressText(
  phase: FollowUpPhase,
  question: Pick<DecisionQuestionContent, "thread">,
  messageId: string
): string | null {
  const entry = question.thread.find(
    (item): item is DecisionThreadMessage => item.type === "message" && item.messageId === messageId
  );
  if (entry !== undefined) {
    if (entry.deliveryStopped === true && entry.deliveryStatus === "delivery-uncertain") {
      return "Follow-up sent. It may or may not have been typed in, and it won't be tried again.";
    }
    if (entry.deliveryStopped === true && entry.deliveryStatus !== "terminal-delivered") {
      return "Follow-up sent to the question's thread. It won't be typed into the terminal: the question was withdrawn, or the follow-up was handled.";
    }
    switch (entry.deliveryStatus) {
      case "terminal-delivered":
        return "Follow-up sent and typed into the terminal";
      case "needs-attention":
        // Its terminal may have closed, so never send the person to that terminal's menu.
        return "Follow-up sent, but it couldn't be typed in. Review it under Needs attention in the Decisions inbox.";
      case "delivery-uncertain":
        return "Follow-up sent. It may or may not have been typed in.";
      default:
        return "Follow-up sent. Waiting for it to be typed into the terminal…";
    }
  }
  switch (phase.kind) {
    case "sending":
      return "Sending your follow-up…";
    case "checking":
      return "Checking whether your follow-up was sent…";
    case "lost":
      return "Couldn't confirm whether your follow-up was sent.";
    case "refused":
      return null;
    case "settled":
      if (phase.outcome.status === "queued") {
        return "Follow-up queued. It's sent once the relay can be reached.";
      }
      return phase.outcome.status === "sent" ? "Follow-up sent" : null;
  }
}
