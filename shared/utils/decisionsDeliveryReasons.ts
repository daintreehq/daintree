import type {
  DecisionClosureNotice,
  DecisionQuestionClosedReason,
  DecisionQuestionStall,
} from "../types/decisionsQuestion.js";

/**
 * Why Daintree stopped typing in an answer or a follow-up, in plain words:
 * the list of answers needing attention (#16020) and a stalled answer's
 * desktop notification (#17235) say the same. Those are read away from the
 * terminal that asked, so it is named rather than "this terminal"; the pane's
 * own chip, read in it, says "here" and "this terminal" (`perspective`).
 */

/**
 * What of a question needs a person: its answer, the follow-ups after it
 * (#16231), or both. In the answer's place, the notice that its deadline
 * closed it without one (#17944).
 */
export type DeliverySubject =
  | "answer"
  | "follow-up"
  | "follow-ups"
  | "answer and follow-up"
  | "answer and follow-ups"
  | "timeout notice"
  | "timeout notice and follow-up"
  | "timeout notice and follow-ups";

/** `notice`: what needs a person in the answer's place is its timeout notice. */
export function deliverySubject(
  answer: boolean,
  followUps: number,
  notice = false
): DeliverySubject {
  const lead = notice ? "timeout notice" : "answer";
  if (followUps === 0) return lead;
  const held = followUps === 1 ? "follow-up" : "follow-ups";
  return answer ? `${lead} and ${held}` : held;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `subject` as a sentence's opening, naming the question it belongs to: "Answer to q-3", "Timeout notice for q-3". */
export function deliverySubjectOf(subject: DeliverySubject, question: string): string {
  return `${capitalized(subject)} ${subject.startsWith("timeout notice") ? "for" : "to"} ${question}`;
}

/** What stopped, as a status line: "Answer needs attention", "Follow-ups need attention". */
export function deliveryAttentionText(subject: DeliverySubject): string {
  return `${capitalized(subject)} ${deliverySubjectPlural(subject) ? "need" : "needs"} attention`;
}

/**
 * What may have been typed, as a status line. `demonstrative` reads it as one
 * item among several on a list ("This answer…") rather than on its own.
 */
export function deliveryUncertainText(subject: DeliverySubject, demonstrative = false): string {
  // Either of two things may have been delivered, not both.
  const either = subject.replace(" and ", " or its ");
  const head = demonstrative
    ? `${deliverySubjectPlural(subject) && !either.includes(" or its ") ? "These" : "This"} ${either}`
    : capitalized(either);
  return `${head} may or may not have been delivered`;
}

/**
 * What of a listed question a person has to decide about, from what its
 * round and stall report (#18054): the timeout notice when it is what
 * delivery stopped on in the answer's place (#17944), as its round reports:
 * expired, or never published, with that notice stopped or possibly typed. A
 * Host from before #17943 reports neither, and its stall reads as an
 * answer's. Null while nothing needs a person.
 */
export function stallSubject(question: {
  stall?: DecisionQuestionStall | null;
  closedReason?: DecisionQuestionClosedReason | null;
  closureNotice?: DecisionClosureNotice | null;
}): DeliverySubject | null {
  const stall = question.stall ?? null;
  if (stall === null) return null;
  const reason = question.closedReason;
  const delivery = question.closureNotice?.delivery;
  const notice =
    stall.answerRevision !== null &&
    (reason === "expired" || reason === "never-published") &&
    (delivery === "needs-attention" || delivery === "uncertain");
  return deliverySubject(stall.answerRevision !== null, stall.followUpIds.length, notice);
}

/** Whether `subject` names one thing or several. */
export function deliverySubjectPlural(subject: DeliverySubject): boolean {
  return subject !== "answer" && subject !== "follow-up" && subject !== "timeout notice";
}

/**
 * The library's codes for a delivery that stopped, in words. A code not here
 * still shows the item; only the explanation is left out.
 */
const REASONS: Record<string, string> = {
  relaunched: "The terminal that asked was relaunched after the question was asked.",
  pane_gone: "The terminal that asked was closed.",
  generation_mismatch: "The terminal that asked was restarted after the question was asked.",
  session_mismatch: "A different agent session is running in the terminal that asked.",
  resume_wrong_worktree: "The resumed agent opened in a different worktree.",
  inject_rejected: "The terminal refused the answer.",
  unavailable_unknown_reason: "The terminal refused the answer.",
  answer_unreadable: "The answer couldn't be decrypted on this computer.",
  message_unreadable: "The follow-up couldn't be decrypted on this computer.",
  no_target: "Nothing matches the terminal that asked.",
  target_mismatch: "Nothing matches the terminal that asked.",
  choice_required: "The answer doesn't fit what the question allows.",
  text_not_allowed: "The answer doesn't fit what the question allows.",
  too_many_choices: "The answer doesn't fit what the question allows.",
  unknown_option: "The answer doesn't fit what the question allows.",
  proxy_forbidden: "The question needs a person's answer, not the decision model's.",
  inject_ambiguous: "Typing it in was interrupted, so it isn't typed again on its own.",
  inject_threw: "Typing it in was interrupted, so it isn't typed again on its own.",
  crash_unreconciled: "Daintree stopped while typing it in, so it isn't typed again on its own.",
  delivered_without_proof: "Typing it in wasn't confirmed, so it isn't typed again on its own.",
  invalid_inject_result: "Typing it in wasn't confirmed, so it isn't typed again on its own.",
  resume_unsupported_agent: "This agent can't be resumed to type it in.",
  resume_other_host: "It was asked on another host.",
  resume_host_unreachable: "The terminal's host couldn't be reached to resume the agent.",
  resume_host_unreadable: "The terminal's host couldn't be read to resume the agent.",
  resume_no_session: "No agent session was recorded to resume.",
  resume_no_worktree: "No worktree was recorded to resume the agent in.",
  resume_worktree_gone: "The worktree that asked is gone.",
  resume_other_worktree: "The agent's session is open in another worktree.",
  resume_unknown_project: "The project that asked isn't open here.",
  resume_panel_limit: "There was no room for another terminal to resume the agent.",
  resume_missing_cli: "The agent's command isn't installed, so it couldn't be resumed.",
  resume_spawn_failed: "The resumed agent didn't start.",
  resume_timeout: "The resumed agent didn't reach its prompt in time.",
  resume_exited: "The resumed agent exited before the answer was typed in.",
  resume_closed: "The resumed terminal was closed before the answer was typed in.",
  resume_no_bearer: "The resumed terminal couldn't be matched to the question.",
  resume_target_changed: "The terminal changed while the agent was resuming.",
  resume_ended: "The terminal resumed for it was closed again.",
  resume_failed: "Resuming the agent failed.",
};

/** Where the words are read: away from the terminal that asked, or in it. */
export type DeliveryPerspective = "away" | "here";

/** The codes whose words name the terminal that asked, as that terminal's own chip says them. */
const HERE: Record<string, string> = {
  relaunched: "This terminal was relaunched after the question was asked.",
  generation_mismatch: "This terminal was restarted after the question was asked.",
  session_mismatch: "A different agent session is running here now.",
  inject_rejected: "This terminal refused the answer.",
  unavailable_unknown_reason: "This terminal refused the answer.",
};

/**
 * A code's words for `subject`, or null for a code with none. A follow-up's
 * own code says what stopped the follow-up, so with no answer needing a
 * person its words name the follow-up.
 */
export function deliveryReasonText(
  code: string,
  subject: DeliverySubject = "answer",
  perspective: DeliveryPerspective = "away"
): string | null {
  // Codes are only shaped like identifiers, so `constructor` must not reach Object's.
  if (!Object.hasOwn(REASONS, code)) return null;
  const text = perspective === "here" && Object.hasOwn(HERE, code) ? HERE[code]! : REASONS[code]!;
  // The code is the notice's own when it leads, as an answer's is.
  if (subject.startsWith("timeout notice")) return text.replace("the answer", "the timeout notice");
  if (subject === "follow-up") return text.replace("the answer", "the follow-up");
  if (subject === "follow-ups") {
    return text
      .replace("the answer was", "the follow-ups were")
      .replace("the answer", "the follow-ups");
  }
  return text;
}
