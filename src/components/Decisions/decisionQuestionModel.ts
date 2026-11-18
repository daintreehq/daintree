import type { DecisionsRequirement } from "@shared/types/decisions";
import type {
  DecisionQuestionContent,
  DecisionQuestionStatus,
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
 * withdrawn from the desktop.
 */
export function questionStatusText(
  question: Pick<DecisionQuestionContent, "status" | "closedReason">
): string {
  return question.closedReason === "declined"
    ? "You declined to answer"
    : STATUS_TEXT[question.status];
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
