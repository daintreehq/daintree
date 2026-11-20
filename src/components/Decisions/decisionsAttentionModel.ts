import { pluralize } from "@/lib/pluralize";
import type {
  DecisionsAnswerDestination,
  DecisionsAnswerOutcome,
  DecisionsAttentionItem,
  DecisionsTimeoutNotice,
} from "@shared/types/decisionsAttention";
import {
  deliveryAttentionText,
  deliveryReasonText,
  deliverySubject,
  deliverySubjectOf,
  deliverySubjectPlural,
  deliveryUncertainText,
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

/**
 * What opens the list of answers needing attention, wherever it is offered:
 * the pane's chip, the inbox and Canopy (#18054).
 */
export const REVIEW_ATTENTION_LABEL = "Review answers";

export function aliasLabel(alias: number): string {
  return `q-${alias}`;
}

export type AttentionSubject = DeliverySubject;

type SubjectFields = Pick<
  DecisionsAttentionItem,
  "answer" | "answerUnavailable" | "notice" | "followUps"
>;

/** What of the question needs a person; a timeout notice (#17944) stands in the answer's place. */
export function subjectOf(item: SubjectFields): AttentionSubject {
  const notice = item.answer === null && item.answerUnavailable === null && item.notice !== null;
  return deliverySubject(
    item.answer !== null || item.answerUnavailable !== null || notice,
    item.followUps.length,
    notice
  );
}

const isPlural = deliverySubjectPlural;

function isNotice(subject: AttentionSubject): boolean {
  return subject.startsWith("timeout notice");
}

export function statusText(item: Pick<DecisionsAttentionItem, "status"> & SubjectFields): string {
  const subject = subjectOf(item);
  return item.status === "delivery-uncertain"
    ? deliveryUncertainText(subject, true)
    : deliveryAttentionText(subject);
}

/**
 * What the copy button copies, in its label's words. A timeout notice is
 * Daintree's to type into the agent that asked, never a person's to paste,
 * so only the follow-ups beside one are copied.
 */
export function copyLabel(item: SubjectFields): string {
  return `Copy ${subjectOf({ ...item, notice: null })}`;
}

/**
 * Whether everything a person can copy is here to copy: the answer, if it
 * needs a person, and each follow-up. A timeout notice alone has nothing to copy.
 */
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
  if (isNotice(subject)) {
    // Nothing of a notice is copied or sent to another agent: Try resume is all it offers.
    const offered = plural ? "Copy and Try resume go" : "Try resume goes";
    return (
      `Its ${subject} ${plural ? "leave" : "leaves"} this list, the pane's chip and Canopy, and ` +
      `Daintree won't type ${it} in. ${offered} with ${it}. ` +
      `The Decisions audit trail records the question as handled.`
    );
  }
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
  "Daintree won't type these answers, timeout notices and follow-ups in on its own. Choose what happens to each one.";
export const EMPTY_DESCRIPTION =
  "Nothing needs attention right now. Answers, timeout notices and follow-ups Daintree won't type in on its own show up here.";

/**
 * How the question itself ended, apart from what became of its notice
 * (#17944): its deadline passed, with no answer or before it reached the relay.
 */
export function noticeOutcomeText(notice: Pick<DecisionsTimeoutNotice, "kind">): string {
  return notice.kind === "never-published"
    ? "Its deadline passed before it reached the relay, so no answer was recorded."
    : "Its deadline passed without an answer.";
}

/**
 * What the notice says of the agent's stated plan, for an advisory round: its
 * words, apart from how far typing it got. Never that the agent read it or
 * acted on it, and never a decision anyone made. Null for a question that
 * waited for a reply, or when it can't be told.
 */
export function noticePlanText(notice: Pick<DecisionsTimeoutNotice, "disposition">): string | null {
  switch (notice.disposition) {
    case "fallback-due":
      return "The notice says the agent may go ahead with its stated plan. Nothing was decided or approved.";
    case "fallback-withheld":
      return "The notice says the agent isn't cleared to go ahead with its plan.";
    default:
      return null;
  }
}

/** How far typing the notice got, in its own right: beside an answer or follow-ups, the status line speaks for them all. */
export function noticeDeliveryText(notice: Pick<DecisionsTimeoutNotice, "delivery">): string {
  return notice.delivery === "delivery-uncertain"
    ? "may or may not have been typed in"
    : "not typed in";
}

/**
 * Whether two reads of a question's item ask the same of the person, by the
 * token main minted for each: the same answer, notice round, follow-ups and
 * run, in the same state. A confirmation asked about one read is dropped
 * once the list no longer shows it so, as main would refuse it.
 */
export function sameAttention(
  a: Pick<DecisionsAttentionItem, "questionId" | "token">,
  b: Pick<DecisionsAttentionItem, "questionId" | "token">
): boolean {
  return a.questionId === b.questionId && a.token === b.token;
}

/**
 * What of the question list bears on this list: the questions that need a
 * person, with what delivery stopped on. A list change that leaves it the
 * same (a new question, a Host's, a mark) is no reason to read this list again.
 */
export function attentionFingerprint(
  questions: readonly {
    reference: { hostId: string; projectId: string; terminalId: string; questionId: string };
    standing: { kind: string; deliveryStatus?: string };
    stall: { answerRevision: number | null; followUpIds: string[]; reason: string } | null;
    closureNotice?: { delivery: string; disposition: string | null } | null;
  }[]
): string {
  return JSON.stringify(
    questions
      .filter((question) => question.standing.kind === "needs-attention")
      .map((question) => [
        question.reference,
        question.standing.deliveryStatus ?? null,
        question.stall,
        question.closureNotice ?? null,
      ])
  );
}

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
    origin.otherHost !== null
      ? `${agent} on ${origin.otherHost.name ?? "another computer"}`
      : origin.paneTitle !== null
        ? `${agent} in “${origin.paneTitle}”`
        : `${agent}, terminal closed`;
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
    primary:
      origin.otherHost !== null
        ? (origin.otherHost.name ?? "Another computer")
        : origin.paneTitle !== null
          ? `“${origin.paneTitle}”`
          : "Terminal closed",
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

/** A destination's second line in the menu, under its project's label: its agent, then its worktree. */
export function destinationRowDetail(
  destination: DecisionsAnswerDestination,
  worktreeName: string | null
): string {
  return [agentLabel(destination), worktreeName].filter((part) => part !== null).join(" · ");
}

/** One project's agents in the destination menu, under the label that names it. */
export interface DestinationGroup {
  projectId: string;
  label: string;
  destinations: DecisionsAnswerDestination[];
}

/**
 * The destination menu's sections (#18056): the asking project's agents
 * first, then each other project's, each in the order main listed them, so
 * an agent in another project is a visible choice. Grouped by id, so two
 * projects of one name, or of none, keep a section each.
 */
export function destinationGroups(
  destinations: readonly DecisionsAnswerDestination[],
  askingProjectId: string
): DestinationGroup[] {
  const ordered = [
    ...destinations.filter((d) => d.projectId === askingProjectId),
    ...destinations.filter((d) => d.projectId !== askingProjectId),
  ];
  const groups = new Map<string, DestinationGroup>();
  for (const destination of ordered) {
    let group = groups.get(destination.projectId);
    if (group === undefined) {
      const kind = destination.projectId === askingProjectId ? "Asking project" : "Other project";
      group = {
        projectId: destination.projectId,
        label: destination.projectName !== null ? `${kind} · ${destination.projectName}` : kind,
        destinations: [],
      };
      groups.set(destination.projectId, group);
    }
    group.destinations.push(destination);
  }
  return [...groups.values()];
}

/**
 * What the move's confirmation promises (#18056): what the chosen agent's
 * delivery waits for, as main read that agent, and that nothing is typed
 * twice. Never a moment: a selector, a draft or a startup still hold it.
 */
export function moveConfirmBody(
  subject: AttentionSubject,
  waitsFor: DecisionsAnswerDestination["waitsFor"]
): string {
  const when =
    waitsFor === "composer"
      ? "when that agent can take input and its composer is empty, even while it's working"
      : "when that agent is at its prompt with its composer empty, never while it's working";
  const twice = isPlural(subject) ? "They're never typed in twice" : "It's never typed in twice";
  return `Daintree types the ${subject} in ${when}. ${twice}, and the Decisions audit trail records the move.`;
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
  asked: AttentionSubject = "answer"
): string {
  // Only the follow-ups are left when the notice sent with them was replaced (#17944).
  const subject: AttentionSubject =
    (outcome.result === "waiting" || outcome.result === "needs-attention") &&
    outcome.followUpsOnly === true
      ? asked.endsWith("follow-ups")
        ? "follow-ups"
        : "follow-up"
      : asked;
  const q = aliasLabel(alias);
  const what = deliverySubjectOf(subject, q);
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
        case "changed":
          return `${q} changed after this list was read, so nothing was done`;
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
