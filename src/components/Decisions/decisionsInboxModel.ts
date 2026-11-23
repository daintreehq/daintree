import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { basename } from "@shared/utils/path";
import { getTerminalTaskTitle } from "@shared/utils/terminalTitleDisplay";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { DecisionsStatus } from "@shared/types/decisions";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { pluralize } from "@shared/utils/pluralize";
import { stripAnsiAndOscCodes } from "@shared/utils/urlUtils";
import {
  deliveryReasonWords,
  isAnswerOnlyCode,
  reasonOnHost,
  stallSubject,
  type DeliverySubject,
} from "@shared/utils/decisionsDeliveryReasons";
import type { ShownNotice } from "./decisionQuestionModel";
import type {
  DecisionPendingDelivery,
  DecisionQuestionContent,
  DecisionQuestionListItem,
  DecisionQuestionMarkResult,
  DecisionQuestionReference,
  DecisionQuestionStanding,
} from "@shared/types/decisionsQuestion";
import type {
  AnswerRecord,
  AnswerSubmission,
  DeclineSubmission,
} from "@/store/decisionsAnswerStore";
import { deadlineElapsed, expiresSoon } from "./decisionDeadline";

export { EXPIRY_SOON_MS, expiresSoon } from "./decisionDeadline";

/**
 * What the Decisions inbox (#17231) says about the questions this computer
 * holds: which group each is in, in what order, and its state in the words
 * the pane's chip uses. Only what the list recorded, never a reading of what
 * the agent is doing.
 */

export type InboxGroupId =
  "needs-you" | "awaiting" | "delivering" | "attention" | "cleared" | "history";

export interface InboxGroup {
  id: InboxGroupId;
  title: string;
  items: DecisionQuestionListItem[];
}

const GROUP_TITLES: Record<InboxGroupId, string> = {
  "needs-you": "Needs you",
  awaiting: "Awaiting update",
  delivering: "Being delivered",
  attention: "Needs attention",
  cleared: "Cleared",
  history: "History",
};

const GROUP_ORDER: readonly InboxGroupId[] = [
  "needs-you",
  "awaiting",
  "delivering",
  "attention",
  "cleared",
  "history",
];

/**
 * The groups that fold (#18023): what's over, and what the person set aside.
 * Both grow without anything waiting on the person, so each opening starts
 * with them shut; what still needs someone never folds.
 */
export function folds(id: InboxGroupId): boolean {
  return id === "cleared" || id === "history";
}

const NONE_OPEN: ReadonlySet<InboxGroupId> = new Set();

/** The questions whose rows are drawn: every group's, except a folding group's while it is shut. */
export function shownItems(
  groups: readonly InboxGroup[],
  open: ReadonlySet<InboxGroupId>
): DecisionQuestionListItem[] {
  return groups.flatMap((group) => (folds(group.id) && !open.has(group.id) ? [] : group.items));
}

/** The shut group a listed question sits in, or null when its row is drawn (or it isn't listed). */
export function hiddenIn(
  groups: readonly InboxGroup[],
  key: string,
  open: ReadonlySet<InboxGroupId>
): InboxGroupId | null {
  const group = groups.find((candidate) =>
    candidate.items.some((item) => referenceKey(item.reference) === key)
  );
  return group !== undefined && folds(group.id) && !open.has(group.id) ? group.id : null;
}

/**
 * A queued question still waits for the person and can be answered here; one
 * that couldn't be sent never reached anyone and is over, like a withdrawn one.
 */
export function groupOf(standing: DecisionQuestionStanding): InboxGroupId {
  switch (standing.kind) {
    case "waiting":
    case "queued":
      return "needs-you";
    case "to-type":
      return "delivering";
    case "needs-attention":
      return "attention";
    case "send-failed":
    case "settled":
      return "history";
  }
}

/**
 * Where the inbox lists the question: by its standing, except that one the
 * person cleared from Needs you on this computer (#17895) waits under
 * Cleared, still answerable, until it asks something new; and one whose
 * deadline passed by this computer's clock at `nowMs` (#17943), which nothing
 * has confirmed closed yet, waits under Awaiting update rather than on the
 * person. Without a clock, as before.
 */
export function inboxGroupOf(
  item: Pick<DecisionQuestionListItem, "standing" | "inbox"> & { expiresAt?: string | null },
  nowMs: number | null = null
): InboxGroupId {
  const group = groupOf(item.standing);
  if (group !== "needs-you") return group;
  if (item.inbox?.cleared === true) return "cleared";
  const elapsed =
    nowMs !== null &&
    deadlineElapsed({ expiresAt: item.expiresAt ?? null, standing: item.standing }, nowMs);
  return elapsed ? "awaiting" : group;
}

/** What an ask whose deadline passed says until the store records how it closed (#17943). */
export const ELAPSED_NOTE = "Deadline passed, awaiting an update";

/**
 * The listed question's current ask, when `shown` lets the person have seen
 * it (#17895): a read of that same question that holds, readable, the agent's
 * follow-up the ask takes in. Null when it doesn't (read before the follow-up
 * came, or the follow-up couldn't be opened), and once the ask is seen.
 */
export function seeableAsk(
  item: Pick<DecisionQuestionListItem, "reference" | "inbox">,
  shown: Pick<DecisionQuestionContent, "reference" | "thread">
): { ask: string | null } | null {
  const inbox = item.inbox;
  if (inbox === undefined || inbox.seen) return null;
  if (
    shown.reference.hostId !== item.reference.hostId ||
    shown.reference.questionId !== item.reference.questionId
  ) {
    return null;
  }
  if (inbox.ask === null) return { ask: null };
  const held = shown.thread.some(
    (entry) =>
      entry.type === "message" &&
      entry.from === "agent" &&
      entry.messageId === inbox.ask &&
      !entry.unreadable
  );
  return held ? { ask: inbox.ask } : null;
}

/**
 * Whether `shown`, a read of the listed question, has its current ask on
 * screen: the question alone, or the agent's follow-up the ask names, even
 * one that couldn't be opened. A clear made from a read that predates the ask
 * would set aside something the person never had in front of them.
 */
export function askShownIn(
  item: Pick<DecisionQuestionListItem, "inbox">,
  shown: Pick<DecisionQuestionContent, "thread">
): boolean {
  const ask = item.inbox?.ask ?? null;
  return (
    ask === null ||
    shown.thread.some(
      (entry) => entry.type === "message" && entry.from === "agent" && entry.messageId === ask
    )
  );
}

/**
 * What a cleared question says of itself to the ear: it still waits for the
 * agent, just not on the person. Never drawn, since the Cleared heading is
 * already above every such row.
 */
export const CLEARED_NOTE = "Cleared on this computer";

/** What a cleared ask whose deadline passed says, the one fact its row draws beyond the heading. */
export const CLEARED_ELAPSED_NOTE = "Deadline passed";

/**
 * What Clear or Restore does, said before it's pressed (#17943): only this
 * computer's inbox moves. Unlike Decline, nothing is declined or sent, and
 * the question stays open for an answer, here or on a phone.
 */
export function clearText(cleared: boolean): string {
  return cleared
    ? "Takes it out of Cleared on this computer. Nothing is sent to the agent or your phones."
    : "Moves it to Cleared on this computer only. Nothing is declined or sent, and while it's open it can still be answered here or on your phone.";
}

/** What the inbox bar's other actions do, said before each is pressed (#18041), as Clear's is. */
export const GO_TO_TERMINAL_TEXT = "Shows the terminal that asked it.";
export const DECLINE_TEXT =
  "Declines it for you. Your phones and an agent still listening are told you chose not to answer.";
export const WITHDRAW_TEXT =
  "Calls it off from this computer. Phones it reached show it withdrawn, and the agent sees it withdrawn when it checks.";
export const RETRY_DECLINE_TEXT =
  "Checks whether your decline went through, and sends the same decline again if it never arrived.";

/**
 * What clearing or restoring says once it lands, for the ear; null when it
 * changed nothing, as when each question had asked something new meanwhile.
 */
export function markedText(
  action: "clear" | "restore",
  result: DecisionQuestionMarkResult
): string | null {
  if (result.result !== "marked") {
    return action === "clear" ? "Couldn't clear on this computer" : "Couldn't restore to Needs you";
  }
  if (result.marked === 0) return null;
  const count = pluralize(result.marked, "question");
  return action === "clear" ? `${count} cleared on this computer` : `${count} back in Needs you`;
}

function epoch(iso: string | null): number {
  if (iso === null) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * The time History sorts by and its rows show (#18025): when the question
 * closed, else when it was asked, as withdrawn or never-sent ones have no
 * close time.
 */
export function closedTime(item: Pick<DecisionQuestionListItem, "settledAt" | "askedAt">): {
  at: string;
  kind: "closed" | "asked";
} {
  return epoch(item.settledAt) === Number.NEGATIVE_INFINITY || item.settledAt === null
    ? { at: item.askedAt, kind: "asked" }
    : { at: item.settledAt, kind: "closed" };
}

function closedAt(item: DecisionQuestionListItem): number {
  return epoch(closedTime(item).at);
}

/**
 * The non-empty groups, in the issue's order. What still needs someone keeps
 * the list's order, oldest first, except that a waiting question whose
 * recorded deadline falls within a day comes first, soonest first; history
 * shows the most recently closed first.
 */
export function inboxGroups(
  questions: readonly DecisionQuestionListItem[],
  nowMs: number | null = null
): InboxGroup[] {
  const byGroup = new Map<InboxGroupId, DecisionQuestionListItem[]>();
  for (const item of questions) {
    const id = inboxGroupOf(item, nowMs);
    const items = byGroup.get(id);
    if (items === undefined) byGroup.set(id, [item]);
    else items.push(item);
  }
  const waiting = byGroup.get("needs-you");
  if (waiting !== undefined && nowMs !== null) {
    const soon = waiting.filter((item) => expiresSoon(item, nowMs));
    if (soon.length > 0) {
      soon.sort((a, b) => epoch(a.expiresAt) - epoch(b.expiresAt));
      byGroup.set("needs-you", [...soon, ...waiting.filter((item) => !soon.includes(item))]);
    }
  }
  const history = byGroup.get("history");
  if (history !== undefined) {
    // A stable sort: questions closed at the same moment keep the list's order.
    history.sort((a, b) => closedAt(b) - closedAt(a));
  }
  return GROUP_ORDER.flatMap((id) => {
    const items = byGroup.get(id);
    return items === undefined ? [] : [{ id, title: GROUP_TITLES[id], items }];
  });
}

/** How many History rows the inbox shows at first, and how many more each ask for older ones shows (#18033). */
export const HISTORY_PAGE = 64;

/**
 * The groups as the list shows them: History, newest first, cut to its
 * first `shown` rows, so a long history mounts and reads a page of rows
 * rather than every past question (#18033). The question `keep` names (the
 * one selected) stays in view however far down it is, after the rows shown,
 * on its own. `hidden` is how many History rows are left out, and `next` the
 * newest of them: the first row showing more brings in.
 */
export function shownGroups(
  groups: readonly InboxGroup[],
  shown: number,
  keep: DecisionQuestionListItem | null
): { groups: InboxGroup[]; hidden: number; next: DecisionQuestionListItem | null } {
  let hidden = 0;
  let next: DecisionQuestionListItem | null = null;
  const cut = groups.map((group) => {
    if (group.id !== "history" || group.items.length <= shown) return group;
    const head = group.items.slice(0, shown);
    const kept = keep !== null && group.items.indexOf(keep) >= shown ? [keep] : [];
    hidden = group.items.length - head.length - kept.length;
    next = group.items.slice(shown).find((item) => item !== keep) ?? null;
    return { ...group, items: [...head, ...kept] };
  });
  return { groups: cut, hidden, next };
}

/** Names the question wherever it is read from. */
export function referenceKey(reference: DecisionQuestionReference): string {
  return [reference.hostId, reference.projectId, reference.terminalId, reference.questionId].join(
    "\u0000"
  );
}

/**
 * The agent's follow-up asking for a reply, by message id, while the question
 * waits on the person for it (#18040): what its row is named by and where it
 * opens. Null for any other, which keeps the question's line and opens at its
 * top: a delivery that stopped leads with that.
 */
export function replyToShow(
  item: Pick<DecisionQuestionListItem, "standing" | "replyRequest">
): string | null {
  return item.standing.kind === "waiting" && item.standing.reason === "reply"
    ? item.replyRequest
    : null;
}

/**
 * Names the request a row's reply line is read for: a new request is a new
 * line, and an earlier one's late read never lands on it. Null for a row that
 * isn't waiting on a reply.
 */
export function replyLineKey(
  item: Pick<DecisionQuestionListItem, "reference" | "standing" | "replyRequest">
): string | null {
  const ask = replyToShow(item);
  return ask === null ? null : `${referenceKey(item.reference)}\u0000${ask}`;
}

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * The opening line of the agent's message `messageId` in `question`'s thread,
 * as a row shows a line: the first with words once escape sequences and
 * controls are gone. Null when the thread doesn't hold it readable.
 */
export function replyLine(
  question: Pick<DecisionQuestionContent, "thread">,
  messageId: string
): string | null {
  const entry = question.thread.find(
    (candidate) => candidate.type === "message" && candidate.messageId === messageId
  );
  if (entry?.type !== "message" || entry.from !== "agent" || entry.unreadable) return null;
  // Sequences first: one can span a line break.
  for (const raw of stripAnsiAndOscCodes(entry.text ?? "").split(/\r\n?|\n|\u2028|\u2029/)) {
    const line = raw.replace(CONTROLS, "").trim();
    if (line !== "") return line;
  }
  return null;
}

/**
 * What a list item says of its round, when its machine said (#17943), and
 * what its delivery stopped on (#17235).
 */
export type ItemRound = Partial<
  Pick<DecisionQuestionListItem, "replyMode" | "closedReason" | "closureNotice" | "stall">
>;

/** How far a held part got: stopped before it was typed in, or maybe typed. */
type HeldDelivery = "stopped" | "uncertain";

interface HeldParts {
  /** The parts as the stall's notification names them, for its reason's words. */
  subject: DeliverySubject;
  /** The library's code for why, as the stall records it. */
  reason: string;
  /** What the answer's slot holds, as far as the list can say; null when only follow-ups are held. */
  slot: "answer" | "timeout notice" | "answer or timeout notice" | null;
  slotDelivery: HeldDelivery;
  followUps: number;
  followUpDelivery: HeldDelivery;
}

/**
 * Whether the list can't say what a held slot holds (#17944): a Host from
 * before #17943 reports no round, and a round reported without its closing
 * notice can't tell that notice from the answer. A code only an answer has
 * says it all the same.
 */
function slotUnknown(round: ItemRound, code: string): boolean {
  const reason = round.closedReason;
  return (
    !isAnswerOnlyCode(code) &&
    (reason === undefined ||
      ((reason === "expired" || reason === "never-published") && round.closureNotice === undefined))
  );
}

/**
 * What delivery stopped on, part by part, or null with no stall recorded.
 * The standing is uncertain when any part is, so only the notice, which
 * reports its own delivery (#17943), is told apart from the follow-ups beside it.
 */
function heldParts(standing: DecisionQuestionStanding, round: ItemRound): HeldParts | null {
  if (standing.kind !== "needs-attention") return null;
  const stall = round.stall ?? null;
  const subject = stallSubject({
    stall,
    closedReason: round.closedReason,
    closureNotice: round.closureNotice,
  });
  if (stall === null || subject === null) return null;
  const any: HeldDelivery =
    standing.deliveryStatus === "delivery-uncertain" ? "uncertain" : "stopped";
  const notice = subject.startsWith("timeout notice");
  return {
    subject,
    reason: stall.reason,
    slot:
      stall.answerRevision === null
        ? null
        : notice
          ? "timeout notice"
          : slotUnknown(round, stall.reason)
            ? "answer or timeout notice"
            : "answer",
    slotDelivery: notice
      ? round.closureNotice?.delivery === "uncertain"
        ? "uncertain"
        : "stopped"
      : any,
    followUps: stall.followUpIds.length,
    followUpDelivery: any,
  };
}

/** The held parts as a row names them, and whether that is more than one. */
function heldName(parts: HeldParts): { name: string; plural: boolean } {
  const followUps =
    parts.followUps === 0 ? null : parts.followUps === 1 ? "follow-up" : "follow-ups";
  const name = [parts.slot, followUps].filter((part) => part !== null).join(" and ");
  return { name, plural: (parts.slot === null ? 0 : 1) + parts.followUps > 1 };
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The question's state, in the chip's words. One sentence, sentence case, no
 * period. With its `round`, each way it closed without an answer reads apart.
 */
export function standingText(standing: DecisionQuestionStanding, round: ItemRound = {}): string {
  switch (standing.kind) {
    case "waiting":
      return standing.reason === "open"
        ? "Waiting for an answer, here or on your phone"
        : "Answered; the agent asked for a reply";
    case "queued":
      return "Queued to send; you can answer it here";
    case "send-failed":
      return round.closedReason === "never-published"
        ? "Deadline passed before it reached the relay"
        : "Couldn't be sent";
    case "to-type":
      // Without what waits (a Remote Host's) nothing says which; `deliveryFacts` does.
      return "Waiting to be typed in";
    case "needs-attention": {
      const parts = heldParts(standing, round);
      if (standing.deliveryStatus === "delivery-uncertain") {
        return parts === null
          ? "May or may not have been delivered"
          : `${capitalized(heldName(parts).name)} may or may not have been typed in`;
      }
      if (parts === null) return "Delivery stopped and needs attention";
      const { name, plural } = heldName(parts);
      return plural
        ? `${capitalized(name)} weren't typed in and need attention`
        : `${capitalized(name)} wasn't typed in and needs attention`;
    }
    case "settled":
      switch (standing.outcome) {
        case "answered":
          // A handled answer was never typed in.
          return standing.handled ? "Answered, marked handled" : "Answered";
        case "withdrawn":
          return "Withdrawn";
        case "expired":
          // A blocking expiry reads as every expiry did; an advisory one is told apart.
          return round.replyMode === "advisory"
            ? "Expired unanswered, advice only"
            : "Expired unanswered";
        case "declined":
          return "Declined";
      }
  }
}

/**
 * What holds an answer or follow-up back from being typed in (#18032), as one
 * branch of the delivery gate (`evaluateWakeGate` with the Decisions options)
 * reads it: a choice dialog on screen, the agent stopped on an error, a turn
 * in a CLI that takes no line mid-turn, or a draft in the hybrid input; or,
 * with nothing of the terminal seen, the host the store recorded it waiting
 * for. Null when what was seen doesn't say which, so nothing is guessed.
 */
export type DeliveryWait = "host" | "choice-dialog" | "error" | "prompt" | "draft";

/**
 * What the inbox observed of the asking terminal: its agent as the terminals
 * this computer runs report it, the record the gate reads, and whether this
 * view's hybrid input holds a draft for it. Another project's view keeps its
 * own drafts, out of sight here.
 */
export interface DeliveryPane {
  detectedAgentId: string | undefined;
  agentState: AgentState | undefined;
  waitingReason: WaitingReason | undefined;
  draft: boolean;
}

/** How each wait finishes the row's sentence, as the pane's chip says it, from outside the pane. */
function waitClause(wait: DeliveryWait | null, them: boolean): string {
  const it = them ? "them" : "it";
  switch (wait) {
    case "host":
      return "delivering when the terminal's host is back";
    case "choice-dialog":
      return `typing ${it} in once the choice dialog in the terminal is closed`;
    case "error":
      return `typing ${it} in once the agent is no longer stopped on an error`;
    case "prompt":
      return `typing ${it} in at the agent's next prompt`;
    case "draft":
      return `typing ${it} in once the draft in the terminal is sent or cleared`;
    case null:
      return "waiting to be typed in";
  }
}

/**
 * The gate's branch for what was seen, in its order. Anything else (text
 * typed in the terminal's own line, a draft in another view, a run still
 * starting, a line about to go out) is out of sight here: null.
 */
export function deliveryWait(
  delivery: Pick<DecisionPendingDelivery, "hostAway">,
  pane: DeliveryPane | null
): DeliveryWait | null {
  // Seen running, its host is back, whatever the store last recorded.
  if (pane === null) return delivery.hostAway ? "host" : null;
  if (pane.detectedAgentId === undefined) return null;
  if (pane.agentState === "waiting" && pane.waitingReason === "approval") return "choice-dialog";
  if (pane.agentState === "waiting" && pane.waitingReason === "error") return "error";
  const queues =
    getEffectiveAgentConfig(pane.detectedAgentId)?.capabilities?.queuesInputWhileWorking === true;
  if (pane.agentState === "working" && !queues) return "prompt";
  // The gate reads the composer only mid-turn, or at a prompt or a question asked in prose.
  const atPrompt =
    pane.agentState === "waiting" &&
    (pane.waitingReason === "prompt" || pane.waitingReason === "question");
  if (pane.agentState !== "working" && !atPrompt) return null;
  return pane.draft ? "draft" : null;
}

/** What waits, as the row names it: the answer, then the person's follow-ups. */
function waitingSubject(delivery: Pick<DecisionPendingDelivery, "answer" | "followUps">): string {
  // One reads as the noun alone ("Answer and follow-up"), more by their count.
  const followUps =
    delivery.followUps === 0
      ? null
      : delivery.followUps === 1
        ? "follow-up"
        : pluralize(delivery.followUps, "follow-up");
  if (!delivery.answer) return followUps === null ? "Answer or follow-up" : capitalized(followUps);
  return followUps === null ? "Answer" : `Answer and ${followUps}`;
}

/** Said of a question waiting to be typed in, whose machine said what waits (#18032). */
export interface DeliveryFacts {
  /** One sentence, sentence case, no period: what waits, and what it waits on. */
  text: string;
  wait: DeliveryWait | null;
  /** Going to the terminal can clear the hold: a dialog or error to deal with, or a draft. */
  clearable: boolean;
  /** The one waiting longest, and when it was recorded. */
  first: DecisionPendingDelivery["first"];
  recordedAt: string;
}

const CLEARABLE: ReadonlySet<DeliveryWait> = new Set(["choice-dialog", "error", "draft"]);

/**
 * What a Being delivered question says of its delivery, from what its machine
 * recorded and what was last observed of its terminal (`pane`, null when
 * nothing was). Null when the question isn't waiting to be typed in, or its
 * machine didn't say what waits (a Remote Host's).
 */
export function deliveryFacts(
  item: Pick<DecisionQuestionListItem, "standing">,
  pane: DeliveryPane | null
): DeliveryFacts | null {
  if (item.standing.kind !== "to-type" || item.standing.delivery === undefined) return null;
  const delivery = item.standing.delivery;
  const wait = deliveryWait(delivery, pane);
  const count = (delivery.answer ? 1 : 0) + delivery.followUps;
  return {
    text: `${waitingSubject(delivery)} received, ${waitClause(wait, count > 1)}`,
    wait,
    clearable: wait !== null && CLEARABLE.has(wait),
    first: delivery.first,
    recordedAt: delivery.recordedAt,
  };
}

/** What the recorded time is of, as its label says it: "Answer recorded 3h ago". */
export function recordedLabel(first: DecisionPendingDelivery["first"]): string {
  return first === "answer" ? "Answer recorded" : "Follow-up recorded";
}

/** Whether the row carries the warning glyph: a person has to decide what happens to it. */
export function isAttention(standing: DecisionQuestionStanding): boolean {
  return standing.kind === "needs-attention";
}

/**
 * What a row says about where its question stands, or null when its group's
 * heading already says it: an open question under "Needs you" is every row
 * there, and the same words four times down a list are noise. The full
 * sentence stays in the row's accessible name either way.
 */
export function rowNote(standing: DecisionQuestionStanding, round: ItemRound = {}): string | null {
  switch (standing.kind) {
    case "waiting":
      return standing.reason === "open" ? null : standingText(standing);
    case "to-type":
      // Its group's bar says it is being delivered.
      return null;
    case "needs-attention": {
      // Its group's bar says it needs attention; the row says what stopped, when the list knows.
      const parts = heldParts(standing, round);
      if (standing.deliveryStatus === "delivery-uncertain") {
        return parts === null
          ? "May not have been delivered"
          : `${capitalized(heldName(parts).name)} may not have been typed in`;
      }
      return parts === null
        ? "Delivery stopped"
        : `${capitalized(heldName(parts).name)} not typed in`;
    }
    case "settled":
      // The finished ring says answered; only an answer that went another way earns words.
      return standing.outcome === "answered" && !standing.handled
        ? null
        : standingText(standing, round);
    default:
      return standingText(standing, round);
  }
}

/**
 * `rowNote`, for a row that may have been cleared (#17895), or whose deadline
 * passed by the clock at `nowMs` (#17943): that is what sets it apart then. A
 * cleared row doesn't say it was cleared (its group's heading does, and
 * `CLEARED_NOTE` is for the ear), only what else is true of it.
 */
export function inboxRowNote(
  item: Pick<
    DecisionQuestionListItem,
    "standing" | "inbox" | "expiresAt" | "replyMode" | "closedReason" | "closureNotice" | "stall"
  >,
  nowMs: number | null = null
): string | null {
  const elapsed = nowMs !== null && deadlineElapsed(item, nowMs);
  switch (inboxGroupOf(item, nowMs)) {
    case "cleared":
      return elapsed ? CLEARED_ELAPSED_NOTE : rowNote(item.standing, item);
    case "awaiting":
      return ELAPSED_NOTE;
    default:
      return rowNote(item.standing, item);
  }
}

/**
 * What a Remote Host's question says while its Host isn't connected (#17943):
 * it is as the Host last reported it. The Host itself is named with the agent.
 */
export const AWAY_NOTE = "Away, as last reported";

function heldSentence(what: string, plural: boolean, delivery: HeldDelivery): string {
  return delivery === "uncertain"
    ? `${capitalized(what)} may or may not have been typed in.`
    : `${capitalized(what)} ${plural ? "weren't" : "wasn't"} typed in.`;
}

/**
 * What the inbox says of the run that asked an open question (#18029): only
 * what was observed, and what delivery's own checks say of resuming it.
 * - `row`: the short fact a row shows;
 * - `detail`: the sentences the question's pane shows;
 * - `composer`: said before an answer is written when nothing observed can
 *   take one, null otherwise;
 * - `gone`: no agent was detected in the terminal that asked, so a person
 *   may set it aside in one step (it stays answerable).
 */
export interface AskerNotes {
  row: string;
  detail: string;
  composer: string | null;
  gone: boolean;
}

type AskerResume = NonNullable<DecisionQuestionListItem["asker"]>["resume"];

const RESUME_REFUSED: Record<
  Exclude<AskerResume, "resumable" | "unknown">,
  (agent: string) => string
> = {
  "unsupported-agent": (agent) => `Daintree doesn't resume ${agent} sessions to take an answer.`,
  "no-session": () => "No session id was recorded when it asked, so its session can't be resumed.",
  "no-worktree": () => "It asked from outside a worktree, so its session can't be resumed.",
  "worktree-missing": () => "Its session can't be resumed without that folder.",
  ended: () =>
    "Its session was already resumed once for an answer and closed again, so it isn't resumed again.",
  "other-worktree": () =>
    "Its session runs there now, so it isn't resumed in the worktree it asked from.",
};

const FOLDER_GONE = "The folder it asked from is gone.";

export function askerNotes(
  item: Pick<DecisionQuestionListItem, "asker" | "remoteHost" | "standing" | "agentKind">
): AskerNotes | null {
  const open =
    (item.standing.kind === "waiting" && item.standing.reason === "open") ||
    item.standing.kind === "queued";
  if (!open) return null;
  const host = item.remoteHost;
  if (host !== undefined && !host.connected) {
    return {
      row: "Terminal status unknown",
      detail: `${host.name} isn't connected, so whether the terminal that asked is still open is unknown.`,
      composer: null,
      gone: false,
    };
  }
  const asker = item.asker;
  if (asker === undefined) return null;
  const folderGone = asker.directory === "missing";
  switch (asker.target) {
    case "unknown":
      // The terminal couldn't be read: the folder is all that was seen.
      return folderGone
        ? { row: "Folder missing", detail: FOLDER_GONE, composer: null, gone: false }
        : null;
    case "running":
      return folderGone
        ? {
            row: "Folder missing",
            detail: "The terminal that asked is still open, but the folder it asked from is gone.",
            composer: null,
            gone: false,
          }
        : null;
    case "agent-undetected":
      return {
        row: folderGone ? "Agent not detected · Folder missing" : "Agent not detected",
        detail: `The terminal that asked is still open, but no agent is detected in it any more.${folderGone ? ` ${FOLDER_GONE}` : ""}`,
        composer:
          "No agent is detected in the terminal that asked. An answer isn't typed in while none is detected there.",
        gone: true,
      };
  }
  const lead =
    asker.target === "closed"
      ? { row: "Terminal ended", detail: "The terminal that asked is no longer running." }
      : asker.target === "trashed"
        ? { row: "Terminal in Trash", detail: "The terminal that asked is in the Trash." }
        : asker.target === "moved"
          ? {
              row: "Terminal moved",
              detail: "The terminal that asked is now in another worktree.",
            }
          : {
              row: "Terminal restarted",
              detail: "The terminal that asked was restarted or reused since it asked.",
            };
  const facts = [lead.row, ...(folderGone ? ["Folder missing"] : [])];
  const said = [lead.detail, ...(folderGone ? [FOLDER_GONE] : [])].join(" ");
  if (asker.resume === "unknown") {
    return {
      row: facts.join(" · "),
      detail: `${said} Whether its session can be resumed couldn't be checked.`,
      composer: null,
      gone: true,
    };
  }
  if (asker.resume === "resumable") {
    return {
      row: [...facts, "Resume possible"].join(" · "),
      detail: `${said} When an answer is sent, Daintree can try to resume its ${agentName(item.agentKind)} session in a new terminal to take it.`,
      composer: null,
      gone: true,
    };
  }
  const refused = RESUME_REFUSED[asker.resume](agentName(item.agentKind));
  return {
    row: [...facts, "Can't resume"].join(" · "),
    detail: `${said} ${refused}`,
    composer: `Nothing observed can take this answer now. ${said} ${refused}`,
    gone: true,
  };
}

/** The questions in Needs you that one press sets aside as having no agent detected (#18029). */
export function goneAsks(
  questions: readonly DecisionQuestionListItem[],
  nowMs: number | null
): DecisionQuestionListItem[] {
  return questions.filter(
    (item) =>
      item.inbox !== undefined &&
      inboxGroupOf(item, nowMs) === "needs-you" &&
      askerNotes(item)?.gone === true
  );
}

/** The one-step clear's label, with how many it sets aside. */
export function clearGoneText(count: number): string {
  return `Clear ${pluralize(count, "question")} with no agent detected`;
}

/** What the one-step clear does, before it's pressed: it stays here, and declines nothing. */
export const CLEAR_GONE_HINT =
  "Moves each question in Needs you whose terminal ended, is in the Trash, moved, was restarted, or has no agent detected to Cleared on this computer. Nothing is declined or withdrawn, and each can still be answered.";

/**
 * What the shown question's warning says while delivery needs a person: what
 * stopped and why, in the words the stall's notification uses, then what to
 * do. Hedged only where the list can't say what stopped. A Remote Host's
 * question invites no choice and makes no claim about resolving it here: only
 * its Host knows what it offers, so what the inbox learns of the Host says so.
 */
export function attentionText(
  item: Pick<DecisionQuestionListItem, "standing" | "remoteHost"> & ItemRound
): string {
  const { standing } = item;
  const uncertain =
    standing.kind === "needs-attention" && standing.deliveryStatus === "delivery-uncertain";
  const host = item.remoteHost?.name ?? null;
  const parts = heldParts(standing, item);
  const sentences: (string | null)[] = [];
  if (parts === null) {
    sentences.push(
      heldSentence("an answer, a notice or a follow-up", false, uncertain ? "uncertain" : "stopped")
    );
  } else {
    const words = deliveryReasonWords(parts.reason, parts.subject);
    // Words for an answer's code would be false of a notice the slot may hold instead.
    const hedged =
      parts.slot === "answer or timeout notice"
        ? words?.replace("the answer", "the answer or timeout notice")
        : words;
    const reason = hedged == null ? null : reasonOnHost(hedged, host);
    const followUps =
      parts.followUps === 0 ? null : parts.followUps === 1 ? "your follow-up" : "your follow-ups";
    const slot = parts.slot === null ? null : `the ${parts.slot}`;
    if (slot !== null && followUps !== null && parts.slotDelivery !== parts.followUpDelivery) {
      // The reason is the slot's, so it follows the slot's sentence.
      sentences.push(
        heldSentence(slot, false, parts.slotDelivery),
        reason,
        heldSentence(followUps, parts.followUps > 1, parts.followUpDelivery)
      );
    } else {
      const what = [slot, followUps].filter((part) => part !== null).join(" and ");
      const delivery = slot !== null ? parts.slotDelivery : parts.followUpDelivery;
      sentences.push(heldSentence(what, heldName(parts).plural, delivery), reason);
    }
  }
  const plural = parts !== null && heldName(parts).plural;
  if (uncertain) sentences.push("Check the terminal before anything is sent again.");
  else if (host === null) sentences.push(`Choose what happens to ${plural ? "them" : "it"}.`);
  return sentences.filter((sentence) => sentence !== null).join(" ");
}

/**
 * The notice that closed the shown question (#17943), with its own delivery,
 * when its warning states that: then the question's facts needn't say it again.
 */
export function attentionNotice(
  item: Pick<DecisionQuestionListItem, "standing"> & ItemRound
): ShownNotice | null {
  const closedReason = item.closedReason;
  if (heldParts(item.standing, item)?.slot !== "timeout notice" || closedReason == null) {
    return null;
  }
  return {
    closedReason,
    delivery: item.closureNotice?.delivery === "uncertain" ? "uncertain" : "needs-attention",
  };
}

/** A question that is over: its row steps down a tone so the live ones lead. */
export function isClosed(standing: DecisionQuestionStanding): boolean {
  return groupOf(standing) === "history";
}

function sameName(a: string, b: string): boolean {
  const plain = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return plain(a) === plain(b);
}

/**
 * Where the question was asked: the worktree, then its project (#18039),
 * dropping the worktree when it is only the project's own folder again. The
 * worktree leads because it tells runs in one project apart, so in a narrow
 * column a long project name gives way before it does.
 */
export function whereFacts(project: string | null, worktree: string | null): string[] {
  if (project !== null && worktree !== null && sameName(project, worktree)) return [project];
  return [worktree, project].filter((part) => part !== null);
}

/** The asking agent by its display name, else the kind it was recorded under. */
export function agentName(agentKind: string): string {
  return getEffectiveAgentConfig(agentKind)?.name ?? agentKind;
}

/**
 * The worktree by the name its project knows it by, when the inbox shows in
 * that project's view, else the folder it was asked in. Null when neither is known.
 */
export function worktreeName(
  item: Pick<DecisionQuestionListItem, "worktreeRoot">,
  known: string | null
): string | null {
  if (known !== null && known !== "") return known;
  const folder = item.worktreeRoot === "" ? "" : basename(item.worktreeRoot);
  return folder === "" ? null : folder;
}

/** The title inputs a run of this computer's fleet carries, as main last reported them. */
export type PaneTitleInputs = Pick<
  FleetRunRow,
  "title" | "titleMode" | "lastObservedTitle" | "agentId" | "launchAgentId" | "agentState" | "cwd"
>;

/**
 * The asking pane's title as its header shows it (#18039): the person's own
 * title; else the agent's task, after a preset's or given name when the pane
 * has one; else the pane's title. A pane that another agent has taken over
 * keeps only a title the person gave it, since the new agent's task would
 * read as the asker's. Null when there is none, or when it only names the
 * agent again, which tells two of its panes apart no better than the agent.
 */
export function paneTitle(run: PaneTitleInputs, agentKind: string, agent: string): string | null {
  const mode = run.titleMode ?? "default";
  const own = run.title?.trim() ?? "";
  let title = own;
  if (mode !== "user") {
    // The agent the pane holds, as a question records its asker: detected, else launched.
    const holds = run.agentId ?? run.launchAgentId;
    if (holds !== undefined && holds !== agentKind) return null;
    const task = getTerminalTaskTitle({
      title: own,
      titleMode: run.titleMode,
      lastObservedTitle: run.lastObservedTitle,
      detectedAgentId: run.agentId,
      agentState: run.agentState,
      cwd: run.cwd,
    });
    // A name that is only the agent's, or that the task already starts with, isn't said twice.
    const named =
      mode === "custom" &&
      own !== "" &&
      !same(own, agent) &&
      !task?.toLowerCase().startsWith(own.toLowerCase());
    if (task !== null) title = named ? `${own}: ${task}` : task;
  }
  return title === "" || same(title, agent) ? null : title;
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Who asked and where, as the list knows it: the agent; the pane by its
 * title, when it is still open on this computer; the Remote Host that asked,
 * and whether it is away; then the worktree and project.
 */
export interface QuestionOrigin {
  agent: string;
  pane: string | null;
  host: string | null;
  away: boolean;
  where: string[];
}

/**
 * Where the question was asked, as the row's quiet line names it (#18039):
 * the agent with its pane or Host, then a closed question's `outcome`, then
 * the place. The line truncates from its end, so the place gives way before
 * the asker does.
 */
export function originFacts(origin: QuestionOrigin, outcome: string | null = null): string[] {
  const asker = [
    origin.agent,
    origin.pane !== null ? `in “${origin.pane}”` : null,
    origin.host !== null ? `on ${origin.host}` : null,
  ]
    .filter((part) => part !== null)
    .join(" ");
  return [
    asker,
    ...(outcome !== null ? [outcome] : []),
    ...(origin.away ? [AWAY_NOTE] : []),
    ...origin.where,
  ];
}

/**
 * Where the question was asked, as the detail header names it: the pane, the
 * Host, then the place. The question names the agent below it.
 */
export function headerFacts(origin: QuestionOrigin): string[] {
  return [
    ...(origin.pane !== null ? [`“${origin.pane}”`] : []),
    ...(origin.host !== null ? [`On ${origin.host}`] : []),
    ...(origin.away ? [AWAY_NOTE] : []),
    ...origin.where,
  ];
}

/** What the zero-question canvas says under its title: where a question would show up. */
export function emptyText(groups: readonly InboxGroup[]): string | null {
  return groups.length === 0
    ? "When an agent asks for your input through Decisions, the question shows up here and on your phone."
    : null;
}

/**
 * How far the list can be taken at its word (#18022): Decisions' status not
 * yet read, read as unknown (the read failed), not connected to its relay
 * (the connection notice says why), its store unreadable (the notice says no
 * question can be read), or connected.
 */
export type InboxReach = "pending" | "unknown" | "unavailable" | "unreadable" | "connected";

/** Each Remote Host away, by name, once: those the list names, then any of its rows'. */
function awayHosts(groups: readonly InboxGroup[], hostsAway: readonly string[]): string[] {
  const names = new Set(hostsAway);
  for (const group of groups) {
    for (const item of group.items) {
      if (item.remoteHost !== undefined && !item.remoteHost.connected) {
        names.add(item.remoteHost.name);
      }
    }
  }
  return [...names];
}

/** Which questions the inbox lists (#18051): every project's, or only the window's own. */
export type InboxScope = "all" | "project";

/** The project a window shows: on this computer, or on the Remote Host the window belongs to. */
export interface WindowProject {
  hostId: string;
  projectId: string;
}

/**
 * Whether the question was asked in the window's own project: in a local
 * window, one of this computer's from its project; in a Remote Host window,
 * one that Host reported from the project the window shows, whether or not
 * the Host is connected now. Null `project`, a window with no project of its
 * own, has none.
 */
export function inWindowProject(
  item: Pick<DecisionQuestionListItem, "reference" | "remoteHost">,
  project: WindowProject | null
): boolean {
  return (
    project !== null &&
    item.reference.projectId === project.projectId &&
    (item.remoteHost?.hostId ?? LOCAL_HOST_ID) === project.hostId
  );
}

/**
 * Whether the inbox offers to narrow to the window's project (#18051): only
 * while it lists both that project's questions and another project's, so the
 * narrowed list is never empty when offered and never the whole list again.
 */
export function scopeOffered(
  questions: readonly DecisionQuestionListItem[],
  project: WindowProject | null
): boolean {
  if (project === null) return false;
  let own = false;
  let other = false;
  for (const item of questions) {
    if (inWindowProject(item, project)) own = true;
    else other = true;
    if (own && other) return true;
  }
  return false;
}

/** The questions the scope lists, in the list's order. */
export function scopedQuestions(
  questions: readonly DecisionQuestionListItem[],
  scope: InboxScope,
  project: WindowProject | null
): readonly DecisionQuestionListItem[] {
  return scope === "project"
    ? questions.filter((item) => inWindowProject(item, project))
    : questions;
}

/**
 * What Clear Needs you is called (#18051): it clears what the list shows, so
 * it names that list whenever it is narrowed or `namesReach`, as beside the
 * switch or once the list holds another project's question; plain while the
 * window's project is all there is.
 */
export function clearAllText(scope: InboxScope, namesReach: boolean): string {
  if (scope === "project") return "Clear Needs you in this project";
  return namesReach ? "Clear Needs you in all projects" : "Clear Needs you";
}

/** The host and question a reference key names, whichever pane and project it is listed under. */
export function questionOfKey(key: string): string {
  const parts = key.split("\u0000");
  return `${parts[0]}\u0000${parts[parts.length - 1]}`;
}

/**
 * The quiet line at the top of the list while Needs you is empty (#18022):
 * that nothing waits on the person, only as far as the list can say. Not
 * connected, with status unknown, or with a Remote Host away (`hostsAway`,
 * or a row's), it speaks for the questions shown and says what it can't
 * vouch for. Null while Needs you has a question, seen ones included, before
 * Decisions' status is read, and while its store can't be read at all.
 * Narrowed to the window's project (#18051), it speaks for that project
 * alone, and names only a Host whose rows it shows as away.
 */
export function waitingText(
  groups: readonly InboxGroup[],
  reach: InboxReach,
  hostsAway: readonly string[] = [],
  scope: InboxScope = "all"
): string | null {
  if (reach === "pending" || reach === "unreadable") return null;
  if (groups.some((group) => group.id === "needs-you")) return null;
  const narrowed = scope === "project";
  // Narrowed, only the Hosts of the rows shown: a Remote Host window's project is that Host's.
  const away = awayHosts(groups, narrowed ? [] : hostsAway);
  if (reach === "connected" && away.length === 0) {
    if (!narrowed) return "No questions waiting on you";
    return groups.length === 0
      ? "No questions in this project"
      : "No questions in this project waiting on you";
  }
  const lead =
    groups.length === 0
      ? narrowed
        ? "No questions in this project"
        : "No questions on this computer"
      : "None of the questions here wait on you";
  const reasons = [
    // Not connected: the connection notice above says why, and what waits for it.
    ...(reach === "unknown"
      ? ["Decisions status couldn't be read, so newer questions may be missing."]
      : []),
    ...(away.length === 1
      ? [`${away[0]} is away, so its questions are as last reported.`]
      : away.length > 1
        ? [
            `${pluralize(away.length, "Remote Host")} are away, so their questions are as last reported.`,
          ]
        : []),
  ];
  return reasons.length === 0 ? lead : `${lead}. ${reasons.join(" ")}`;
}

/**
 * The question chosen in the inbox, where it stood among the drawn rows (the
 * place it was last drawn at, while a shut group hides it), and whether the
 * person picked it (a row, or Next question) rather than the inbox choosing
 * it on opening.
 */
export interface InboxChoice {
  key: string;
  index: number;
  picked: boolean;
}

/** The groups whose first question the inbox opens on by itself: each still needs something. */
const AUTO_OPEN: ReadonlySet<InboxGroupId> = new Set([
  "needs-you",
  "awaiting",
  "delivering",
  "attention",
]);

/**
 * Whether a question was asked on the machine a view works on (#18049): this
 * computer's own for a local view (`hostId` "local"), else the enrolled Host
 * with that host-list id. Ids repeat from one machine to the next, so a
 * terminal or project id means nothing without it.
 */
export function askedOnHost(item: DecisionQuestionListItem, hostId: string): boolean {
  return hostId === LOCAL_HOST_ID
    ? item.remoteHost === undefined
    : item.remoteHost?.hostId === hostId;
}

/**
 * A question the inbox was asked to show (#18047): by its full reference, or
 * one of a pane's by its terminal and id. A question's id is its own, so the
 * pane's row names that question whichever project it was asked in.
 */
export interface InboxAsked {
  terminalId: string;
  questionId: string;
  reference?: DecisionQuestionReference;
}

/**
 * The listed question `asked` names, in any group; undefined while it isn't
 * listed. One named by its terminal and id is looked for on the view's own
 * machine (`viewHostId`), as the opener's pane is.
 */
export function findAsked(
  ordered: readonly DecisionQuestionListItem[],
  asked: InboxAsked,
  viewHostId: string = LOCAL_HOST_ID
): DecisionQuestionListItem | undefined {
  if (asked.reference !== undefined) {
    const key = referenceKey(asked.reference);
    return ordered.find((item) => referenceKey(item.reference) === key);
  }
  return ordered.find(
    (item) =>
      askedOnHost(item, viewHostId) &&
      item.reference.terminalId === asked.terminalId &&
      item.reference.questionId === asked.questionId
  );
}

/**
 * The question the inbox shows: the one the person picked while it is still
 * listed, under a shut group too, and even under another pane once its answer
 * was sent there (#18027), or for one that went, the drawn row that took its
 * place, never one a shut group hides (#18023); else the question it was asked
 * to show (#18047), in any group, once it is listed; else the one it opened on
 * by itself while that is still listed; else the first of the pane that opened
 * the inbox, on the view's own machine (`viewHostId`), in any group; else,
 * for an opening that prefers it, the first stopped delivery (#18048); else
 * the first of the window's own project that needs the person (#18051); else
 * the first that still needs something (#18022). Null when nothing does: a
 * Cleared or History question opens only when it's picked or asked for.
 */
export function resolveSelection(
  groups: readonly InboxGroup[],
  chosen: InboxChoice | null,
  openerTerminalId: string | null,
  viewHostId: string = LOCAL_HOST_ID,
  windowProject: WindowProject | null = null,
  open: ReadonlySet<InboxGroupId> = NONE_OPEN,
  asked: InboxAsked | null = null,
  prefer: "stopped" | null = null
): DecisionQuestionListItem | null {
  const ordered = groups.flatMap((group) => group.items);
  let kept: DecisionQuestionListItem | undefined;
  if (chosen !== null) {
    const question = questionOfKey(chosen.key);
    kept =
      ordered.find((item) => referenceKey(item.reference) === chosen.key) ??
      ordered.find((item) => questionOfKey(referenceKey(item.reference)) === question);
    if (chosen.picked) {
      if (kept !== undefined) return kept;
      const shown = shownItems(groups, open);
      if (shown.length > 0) return shown[Math.min(Math.max(chosen.index, 0), shown.length - 1)]!;
    }
  }
  // Ahead of what the inbox chose by itself, so one listed after the opening still takes its place.
  if (asked !== null) {
    const found = findAsked(ordered, asked, viewHostId);
    if (found !== undefined) return found;
  }
  if (kept !== undefined) return kept;
  if (openerTerminalId !== null) {
    const own = ordered.find(
      (item) => item.reference.terminalId === openerTerminalId && askedOnHost(item, viewHostId)
    );
    if (own !== undefined) return own;
  }
  if (prefer === "stopped") {
    const stopped = groups.find((group) => group.id === "attention")?.items[0];
    if (stopped !== undefined) return stopped;
  }
  const waitingHere = groups
    .find((group) => group.id === "needs-you")
    ?.items.find((item) => inWindowProject(item, windowProject));
  if (waitingHere !== undefined) return waitingHere;
  return groups.find((group) => AUTO_OPEN.has(group.id))?.items[0] ?? null;
}

/**
 * The question to go on to from the one keyed `from`: the first in Needs you
 * the person hasn't seen, else the first there, never `from` itself. Null
 * when nothing else waits.
 */
export function nextWaiting(
  groups: readonly InboxGroup[],
  from: string | null
): DecisionQuestionListItem | null {
  const waiting = (groups.find((group) => group.id === "needs-you")?.items ?? []).filter(
    (item) => referenceKey(item.reference) !== from
  );
  return waiting.find((item) => item.inbox?.seen !== true) ?? waiting[0] ?? null;
}

/**
 * The question to go on to once the one keyed `from` leaves the group it was
 * acted on in: the next waiting in Needs you, else, for one that left
 * Cleared (#18130), the first still in Cleared of those listed after it
 * there (`following`), else the last in Cleared, so someone working through
 * Cleared stays in it. Null when there is neither.
 */
export function nextAfter(
  groups: readonly InboxGroup[],
  from: string | null,
  left: "needs-you" | "cleared",
  following: readonly string[]
): DecisionQuestionListItem | null {
  const waiting = nextWaiting(groups, from);
  if (waiting !== null || left !== "cleared") return waiting;
  const cleared = (groups.find((group) => group.id === "cleared")?.items ?? []).filter(
    (item) => referenceKey(item.reference) !== from
  );
  for (const key of following) {
    const found = cleared.find((item) => referenceKey(item.reference) === key);
    if (found !== undefined) return found;
  }
  return cleared[cleared.length - 1] ?? null;
}

/** What the person did from the inbox to a question in Needs you (#18035), or a decline from Cleared (#18130). */
export type InboxAction = "answer" | "clear" | "dismiss" | "withdraw";

/** Where what the person did stands by its own record: taken, refused or over, or not yet known. */
export type InboxActionFate = "taken" | "failed" | "open";

/**
 * Whether the question is listed where the person's action takes it: an
 * answer into delivery or past it, a clear to Cleared, a dismissal or
 * withdrawal to History as such. Anywhere else, something other than that
 * action moved it, as a phone's answer moves one the person was dismissing.
 */
export function landedBy(
  action: InboxAction,
  item: Pick<DecisionQuestionListItem, "standing">,
  group: InboxGroupId
): boolean {
  const { standing } = item;
  switch (action) {
    case "answer":
      return (
        group === "delivering" ||
        group === "attention" ||
        (standing.kind === "settled" && standing.outcome === "answered")
      );
    case "clear":
      return group === "cleared";
    case "dismiss":
      return standing.kind === "settled" && standing.outcome === "declined";
    case "withdraw":
      return standing.kind === "settled" && standing.outcome === "withdrawn";
  }
}

/**
 * Where the answer the inbox's Send started stands: the submission that
 * Send made is any but `prior`, the one the record held as it was pressed.
 * Taken once the relay took it; a queued one may still be turned away, as
 * one the phone beat to it is. Failed once it was refused or settled any
 * other way, or Send stopped before signing anything.
 */
export function answerFate(
  record: Pick<AnswerRecord, "preparing" | "hold"> & {
    submission: Pick<AnswerSubmission, "answerId" | "phase"> | null;
  },
  prior: string | null
): InboxActionFate {
  const submission = record.submission;
  if (submission === null || submission.answerId === prior) {
    return !record.preparing && record.hold !== null ? "failed" : "open";
  }
  const phase = submission.phase;
  if (phase.kind === "refused") return "failed";
  if (phase.kind !== "settled") return "open";
  if (phase.outcome.status === "sent") return "taken";
  return phase.outcome.status === "queued" ? "open" : "failed";
}

/**
 * Where a dismissal confirmed from the inbox stands: taken once declined. A
 * queued one is read again until it settles, and meanwhile a phone's
 * dismissal of the same question would list it declined just the same.
 */
export function dismissFate(decline: Pick<DeclineSubmission, "phase"> | null): InboxActionFate {
  const phase = decline?.phase ?? null;
  if (phase === null) return "open";
  if (phase.kind === "refused") return "failed";
  if (phase.kind !== "settled") return "open";
  if (phase.outcome.status === "declined") return "taken";
  return phase.outcome.status === "queued" ? "open" : "failed";
}

/**
 * What the question asks of the person now, as the list names it: the
 * agent's request for a reply and the ask it was shown with. One that
 * changes while it waits is something new, not what the person acted on.
 */
export function askKey(item: Pick<DecisionQuestionListItem, "replyRequest" | "inbox">): string {
  return [item.replyRequest ?? "", item.inbox?.ask ?? ""].join("\u0000");
}

const ACTED: Record<InboxAction, (label: string) => string> = {
  answer: (label) => `Answer sent for question ${label}`,
  clear: (label) => `Question ${label} cleared on this computer`,
  dismiss: (label) => `Question ${label} declined`,
  withdraw: (label) => `Question ${label} withdrawn`,
};

function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/**
 * What the inbox says once the person's action has moved a question out of
 * Needs you (#18035), for the ear: the question by name and the group it's
 * in now, then the question shown in its place, or else what the line above
 * the list says now that nothing else waits.
 */
export function movedText(
  action: InboxAction,
  label: string,
  group: string,
  next: string | null,
  waiting: string | null
): string {
  const moved = `${ACTED[action](label)}. It's in ${group} now.`;
  if (next !== null) return `${moved} Showing ${next}.`;
  return waiting === null ? moved : `${moved} ${sentence(waiting)}`;
}

export interface ConnectionNotice {
  severity: "info" | "neutral" | "warning";
  text: string;
}

/** Why a relay that is set up isn't connected to, as Settings → Decisions shows it. */
const PROBLEMS: Record<NonNullable<DecisionsStatus["problem"]>, string> = {
  keys: "This computer's Decisions keys couldn't be read, so it isn't connected to the relay.",
  storage:
    "The Decisions database on this computer couldn't be opened, so no questions can be read or kept.",
  "other-relay":
    "The Decisions database on this computer holds another relay's questions, so it isn't connected to this one.",
};

/**
 * What the inbox says while this computer isn't connected to its relay: that
 * none is set up yet, why one that is can't be connected to, that the relay
 * revoked it, or that it is connecting. Null while connected, or before main
 * has said.
 */
export function connectionNotice(
  status: Pick<DecisionsStatus, "state" | "relayOrigin" | "problem"> | null
): ConnectionNotice | null {
  if (status === null || status.state === "connected" || status.state === "off") return null;
  if (status.problem !== undefined) {
    return {
      severity: "warning",
      text: `${PROBLEMS[status.problem]} Settings → Decisions says what to do.`,
    };
  }
  if (status.relayOrigin === undefined) {
    return {
      severity: "info",
      text: "No relay is connected yet, so no agent can ask you anything. Set one up in Settings → Decisions.",
    };
  }
  if (status.state === "revoked") {
    return {
      severity: "warning",
      text: "The relay revoked this computer, so no new questions reach it. Settings → Decisions says what to do.",
    };
  }
  return {
    severity: "neutral",
    text: "Not connected to the relay. These are the questions this computer already holds; new ones, answers and declines wait until it reconnects.",
  };
}
