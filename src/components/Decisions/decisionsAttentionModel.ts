import { pluralize } from "@/lib/pluralize";
import type {
  DecisionsAnswerDestination,
  DecisionsAnswerOutcome,
  DecisionsAttentionItem,
} from "@shared/types/decisionsAttention";
import {
  deliveryReasonText,
  deliverySubject,
  type DeliverySubject,
} from "@shared/utils/decisionsDeliveryReasons";

/**
 * What the needs-attention list says (#16020). Observations only: what
 * happened to an answer, and what Daintree will and won't do with it, never
 * a reading of what the agent is doing. The pane chip says the same things
 * from inside the terminal; here the terminal is one of several, so it is
 * named rather than "this terminal".
 */

/**
 * Why delivery stopped, in the words a stalled answer's desktop notification
 * uses too (#17235).
 */
export const reasonText = deliveryReasonText;

export function aliasLabel(alias: number): string {
  return `q-${alias}`;
}

export type AttentionSubject = DeliverySubject;

type SubjectFields = Pick<DecisionsAttentionItem, "answer" | "answerUnavailable" | "followUps">;

export function subjectOf(item: SubjectFields): AttentionSubject {
  return deliverySubject(
    item.answer !== null || item.answerUnavailable !== null,
    item.followUps.length
  );
}

function isPlural(subject: AttentionSubject): boolean {
  return subject !== "answer" && subject !== "follow-up";
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const UNCERTAIN_STATUS: Record<AttentionSubject, string> = {
  answer: "This answer may or may not have been delivered",
  "follow-up": "This follow-up may or may not have been delivered",
  "follow-ups": "These follow-ups may or may not have been delivered",
  "answer and follow-up": "This answer or its follow-up may or may not have been delivered",
  "answer and follow-ups": "This answer or its follow-ups may or may not have been delivered",
};

export function statusText(item: Pick<DecisionsAttentionItem, "status"> & SubjectFields): string {
  const subject = subjectOf(item);
  if (item.status === "delivery-uncertain") return UNCERTAIN_STATUS[subject];
  return `${capitalized(subject)} ${isPlural(subject) ? "need" : "needs"} attention`;
}

/** What the copy button copies, in its label's words. */
export function copyLabel(item: SubjectFields): string {
  return `Copy ${subjectOf(item)}`;
}

/** Whether everything that needs a person is here to copy: the answer, if it does, and each follow-up. */
export function canCopy(item: SubjectFields): boolean {
  const answerHeld = item.answer !== null || item.answerUnavailable !== null;
  if (answerHeld && item.answer === null) return false;
  if (item.followUps.some((followUp) => followUp.unreadable)) return false;
  return answerHeld || item.followUps.length > 0;
}

/**
 * Whether Mark handled asks first (#16638). While the answer can still be
 * resumed or sent to another agent, handling it takes those, and Copy, off
 * the list for good. Where neither is offered (delivery uncertain, the
 * answer unreadable, asked on another host) it is the way out, so one click
 * is enough.
 */
export function handledNeedsConfirm(
  item: Pick<DecisionsAttentionItem, "canResume" | "canReassign">
): boolean {
  return item.canResume || item.canReassign;
}

export function handledConfirmTitle(alias: number): string {
  return `Mark ${aliasLabel(alias)} handled?`;
}

/** What marking handled takes away, in agreement with how many things it holds. */
export function handledConfirmBody(subject: AttentionSubject): string {
  const plural = isPlural(subject);
  const it = plural ? "them" : "it";
  return (
    `Its ${subject} ${plural ? "leave" : "leaves"} this list, the pane's chip and Canopy, and ` +
    `Daintree won't type ${it} in. Copy, Try resume and Choose destination go with ${it}, so ` +
    `${plural ? "they" : "it"} can't be copied or sent to an agent from here afterwards. ` +
    `The Decisions audit trail records the question as handled.`
  );
}

/** The agent's name, falling back to its id. */
export function agentLabel(origin: { agentId: string; agentName: string | null }): string {
  return origin.agentName ?? origin.agentId;
}

/** The dialog's opening line, which also tells a screen reader what the list is. */
export const LIST_DESCRIPTION =
  "Daintree won't type these answers and follow-ups in on its own. Choose what happens to each one.";
export const EMPTY_DESCRIPTION =
  "Nothing needs attention right now. Answers and follow-ups Daintree won't type in on its own show up here.";

/** Why an item shows no answer: there is none waiting, or this computer can't open it. */
export function missingAnswerText(unavailable: "none" | "unreadable" | null): string {
  return unavailable === "unreadable"
    ? "There's nothing here to type in or copy."
    : "No answer is waiting to be typed in for it, so there's nothing to copy.";
}

/** What a resume does while it runs, and how long that can take. */
export const RESUME_PENDING =
  "Reopening the agent's session and waiting for its prompt. This can take up to a minute and a half.";
export const STILL_WORKING = "Still working…";

/**
 * Where it was asked: the agent and its terminal, then the project and
 * worktree. A terminal that is gone says so rather than showing nothing.
 */
export function originParts(
  item: DecisionsAttentionItem,
  worktreeName: string | null
): { pane: string; place: string | null } {
  const { origin } = item;
  const agent = agentLabel(origin);
  const pane =
    origin.paneTitle !== null ? `${agent} in “${origin.paneTitle}”` : `${agent}, terminal closed`;
  const place = [origin.projectName, worktreeName].filter((part) => part !== null).join(" · ");
  return { pane, place: place === "" ? null : place };
}

/** A pane as the confirmation names it: its title (or that it's closed), then its agent and place. */
export interface PaneLines {
  primary: string;
  detail: string;
}

/** The confirmation's From: the asking pane, or that it's closed, then where it ran. */
export function fromLines(item: DecisionsAttentionItem, worktreeName: string | null): PaneLines {
  const { origin } = item;
  return {
    primary: origin.paneTitle !== null ? `“${origin.paneTitle}”` : "Terminal closed",
    detail: [agentLabel(origin), origin.projectName, worktreeName]
      .filter((part) => part !== null)
      .join(" · "),
  };
}

/** The confirmation's To: the chosen pane, then its agent and where it runs. */
export function toLines(
  destination: DecisionsAnswerDestination,
  worktreeName: string | null
): PaneLines {
  return {
    primary: `“${destination.title}”`,
    detail: destinationDetail(destination, worktreeName),
  };
}

/** The footer's count of what is left: questions, whose answer or follow-ups need a person. */
export function remainingText(count: number): string {
  return pluralize(count, "question needs attention", "questions need attention");
}

/** A destination's second line: its agent, then where it runs. */
export function destinationDetail(
  destination: DecisionsAnswerDestination,
  worktreeName: string | null
): string {
  const parts = [agentLabel(destination)];
  if (destination.projectName !== null) parts.push(destination.projectName);
  if (worktreeName !== null) parts.push(worktreeName);
  return parts.join(" · ");
}

/** A pane as a confirmation names it: its title, or its agent when it has none. */
export function paneName(title: string | null, agent: string): string {
  return title !== null && title.trim() !== "" ? `“${title}”` : agent;
}

/**
 * What an action did, as one sentence naming the question and what of it
 * was acted on: what the list shows and announces. A result that leaves the
 * item listed says why.
 */
export function outcomeText(
  alias: number,
  outcome: DecisionsAnswerOutcome,
  subject: AttentionSubject = "answer"
): string {
  const q = aliasLabel(alias);
  const what = `${capitalized(subject)} to ${q}`;
  const plural = isPlural(subject);
  const needs = plural ? "need" : "needs";
  switch (outcome.result) {
    case "delivered":
      return outcome.title !== null ? `${what} typed into “${outcome.title}”` : `${what} typed in`;
    case "waiting": {
      const where = outcome.title !== null ? `“${outcome.title}”` : "its terminal";
      const goes = plural ? "go" : "goes";
      const when = {
        host: "once its host is back",
        composer: "once its composer is empty",
        prompt: "at the agent's next prompt",
      }[outcome.waitsFor];
      return `${what} ${goes} to ${where}, typed in ${when}`;
    }
    case "needs-attention":
      // The item shows the new reason; the line says only what became of it.
      return outcome.status === "delivery-uncertain"
        ? `${what} may or may not have been delivered, and still ${needs} attention`
        : `${what} ${plural ? "weren't" : "wasn't"} typed in and still ${needs} attention`;
    case "handled":
      return `${what} marked handled`;
    case "resolved":
      return `${what} no longer ${needs} attention`;
    case "refused":
      switch (outcome.reason) {
        case "not-running":
          return "Decisions isn't running, so nothing changed";
        case "uncertain":
          return `${what} may already have been typed in, so ${plural ? "they aren't" : "it isn't"} typed again`;
        case "no-answer":
          return `No answer is kept for ${q}`;
        case "destination-gone":
          return `That terminal is no longer running an agent, so ${q}'s ${subject} ${plural ? "weren't" : "wasn't"} sent`;
        case "asker-only":
          return `${q} asked for advice, so only the agent that asked it can take its ${subject}`;
      }
  }
}

/** Whether an outcome takes the item off the list. */
export function leavesList(outcome: DecisionsAnswerOutcome): boolean {
  return (
    outcome.result === "delivered" ||
    outcome.result === "waiting" ||
    outcome.result === "handled" ||
    outcome.result === "resolved"
  );
}

/** How an outcome reads: done, or not done. */
export function outcomeSeverity(outcome: DecisionsAnswerOutcome | null): "success" | "warning" {
  return outcome !== null && leavesList(outcome) ? "success" : "warning";
}
