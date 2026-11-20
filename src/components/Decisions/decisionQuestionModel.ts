import type { DecisionsRequirement } from "@shared/types/decisions";
import { pluralize } from "@/lib/pluralize";
import type {
  DecisionClosureNotice,
  DecisionPreparation,
  DecisionQuestionContent,
  DecisionQuestionStatus,
  DecisionReplyMode,
  DecisionThreadAnswer,
  DecisionThreadEntry,
} from "@shared/types/decisionsQuestion";

/**
 * What the Decisions question view says about a question (#17098). Only what
 * the store recorded: its status, who answered, and when.
 */

export function aliasLabel(alias: number): string {
  return `q-${alias}`;
}

const STATUS_TEXT: Record<DecisionQuestionStatus, string> = {
  queued: "Queued to send",
  open: "Waiting for an answer",
  "proxy-answered": "Answered by the decision model",
  "human-answered": "Answered",
  cancelled: "Cancelled",
  expired: "Expired unanswered",
  "publish-failed": "Couldn't be sent",
};

/**
 * What the view says of the question's status: a cancelled one the person
 * declined from their phone or tablet (#17234) says so, apart from one
 * withdrawn; and, with its round (#17943), an advisory round's expiry apart
 * from a blocking one's, and a question whose deadline passed before it ever
 * reached the relay apart from one the relay refused.
 */
export function questionStatusText(
  question: Pick<DecisionQuestionContent, "status" | "closedReason" | "replyMode">
): string {
  switch (question.closedReason) {
    case "declined":
      return "You declined to answer";
    case "withdrawn":
      return "Withdrawn";
    case "never-published":
      return "Deadline passed before it reached the relay";
    case "expired":
      return question.replyMode === "advisory"
        ? "Expired unanswered, advice only"
        : STATUS_TEXT.expired;
    default:
      return STATUS_TEXT[question.status];
  }
}

/**
 * The round's mode as the deadline line names it (#17943): whether the agent
 * asked for advice or waits for a reply. Null where its machine didn't say.
 */
export function replyModeText(replyMode: DecisionReplyMode | undefined): string | null {
  if (replyMode === undefined) return null;
  return replyMode === "advisory" ? "Advisory" : "Reply required";
}

const PREPARATION_OUTCOME: Record<DecisionPreparation["outcome"], string> = {
  agreed: "Agreed on a recommendation",
  split: "Split or inconclusive",
  "not-run": "Consultation not run",
};

/**
 * What the agent says of its preparation (#18042), in its order: how many
 * other agents it consulted, and how that went. A consultation that never ran
 * says so alone, unless the agent still names agents it consulted.
 */
export function preparationFacts(
  preparation: Pick<DecisionPreparation, "agentsConsulted" | "outcome">
): string[] {
  const outcome = PREPARATION_OUTCOME[preparation.outcome];
  const { agentsConsulted } = preparation;
  if (preparation.outcome === "not-run" && agentsConsulted === 0) return [outcome];
  const consulted =
    agentsConsulted === 0
      ? "No other agents consulted"
      : `${pluralize(agentsConsulted, "other agent")} consulted`;
  return [consulted, outcome];
}

/** What heads the agent's plan: what it said it would do, while that can still come (#17943). */
export function planHeading(status: DecisionQuestionStatus): string {
  return status === "open" || status === "queued"
    ? "If unanswered, the agent plans to"
    : "The agent's plan if unanswered";
}

const NOTICE_NAME: Record<"declined" | "expired" | "never-published", string> = {
  declined: "Your decline",
  // Both close a round at its deadline: the list and the notification call it the same (#17944).
  expired: "The timeout notice",
  "never-published": "The timeout notice",
};

const NOTICE_DELIVERY: Record<DecisionClosureNotice["delivery"], string> = {
  pending: "is waiting to be typed into the terminal",
  delivered: "was typed into the terminal",
  uncertain: "may or may not have been typed into the terminal",
  "needs-attention": "stopped before it was typed into the terminal",
  stopped: "won't be typed into the terminal",
};

/**
 * How far the notice that closed it without an answer got into the asking
 * terminal (#17943), and, for an advisory round, what that notice says of the
 * agent's plan. Only what was recorded: typed in is never that the agent
 * read it or acted on it. Null with no such notice.
 */
export function closureNoticeText(
  question: Pick<DecisionQuestionContent, "closedReason" | "closureNotice">
): string | null {
  const notice = question.closureNotice;
  const reason = question.closedReason;
  if (notice == null || reason === null || reason === "withdrawn") return null;
  const delivery = `${NOTICE_NAME[reason]} ${NOTICE_DELIVERY[notice.delivery]}.`;
  const plan = noticePlan(notice);
  return plan === null ? delivery : `${delivery} ${plan}`;
}

/**
 * What an advisory notice says of the plan (#17944): its words, apart from
 * how far it got, which the sentence before says. Typed in is only that the
 * terminal took it, never that the agent read it or went ahead; one that will
 * never be typed says nothing of the plan.
 */
function noticePlan(notice: DecisionClosureNotice): string | null {
  if (notice.disposition === null || notice.delivery === "stopped") return null;
  return notice.disposition === "fallback-due"
    ? "It says the agent may go ahead with its plan."
    : "It says the agent isn't cleared to go ahead with its plan.";
}

const REQUIREMENT_TEXT: Record<DecisionsRequirement, string> = {
  "human-required": "Needs a person's answer",
  "proxy-ok": "The decision model may answer",
  "proxy-first": "The decision model may answer first",
};

export function requirementText(requirement: DecisionsRequirement): string {
  return REQUIREMENT_TEXT[requirement];
}

/** Who wrote a thread entry and what it is, as its heading says. */
export function threadEntryHeading(entry: DecisionThreadEntry): string {
  switch (entry.type) {
    case "expired":
      return "Expired unanswered";
    case "declined":
      return "Declined by you";
    case "message":
      if (entry.from === "agent") {
        return entry.expectsReply
          ? "Follow-up from the agent, asking for a reply"
          : "Follow-up from the agent";
      }
      // A Remote Host from before #17238 doesn't say: its messages are all a phone's.
      return entry.onComputer === true
        ? "Follow-up from your computer"
        : "Follow-up from your phone";
    case "answer":
      if (entry.from === "model") return "Decision model's answer";
      if (entry.confirmsModel) return "Confirmed the decision model's answer";
      if (entry.onComputer) {
        return entry.correction ? "Correction from your computer" : "Answer from your computer";
      }
      return entry.correction ? "Correction from your phone" : "Answer from your phone";
  }
}

/**
 * An answer's choices by the label they had when chosen, else the question's
 * own label for that option, else the id, so a choice is never blank.
 */
export function choiceLabels(
  answer: DecisionThreadAnswer,
  options: DecisionQuestionContent["options"]
): string[] {
  return answer.choices.map(
    (choice) =>
      choice.label ?? options.find((option) => option.id === choice.id)?.label ?? choice.id
  );
}

/** What stands in for an entry with nothing to read, or null when it has words or choices. */
export function emptyEntryText(entry: DecisionThreadEntry): string | null {
  if (entry.type === "expired" || entry.type === "declined") return null;
  if (entry.unreadable) return "This couldn't be opened on this computer.";
  const hasChoices = entry.type === "answer" && entry.choices.length > 0;
  if (entry.text !== null || hasChoices) return null;
  return entry.images.length > 0 ? "Images only; they aren't shown here." : "No words were sent.";
}

/** "2 of 4", for a view stepping through several questions; null for one. */
export function positionText(index: number, count: number): string | null {
  if (count < 2) return null;
  return `${(index + 1).toLocaleString()} of ${count.toLocaleString()}`;
}
