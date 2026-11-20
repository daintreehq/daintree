import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { basename } from "@shared/utils/path";
import type { DecisionsStatus } from "@shared/types/decisions";
import { pluralize } from "@shared/utils/pluralize";
import type {
  DecisionQuestionContent,
  DecisionQuestionListItem,
  DecisionQuestionMarkResult,
  DecisionQuestionReference,
  DecisionQuestionStanding,
} from "@shared/types/decisionsQuestion";
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
 * computer's inbox moves. Unlike Dismiss, nothing is declined or sent, and
 * the question stays open for an answer, here or on a phone.
 */
export function clearText(cleared: boolean): string {
  return cleared
    ? "Takes it out of Cleared on this computer. Nothing is sent to the agent or your phones."
    : "Moves it to Cleared on this computer only. Nothing is declined or sent, and while it's open it can still be answered here or on your phone.";
}

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

/** Names the question wherever it is read from. */
export function referenceKey(reference: DecisionQuestionReference): string {
  return [reference.hostId, reference.projectId, reference.terminalId, reference.questionId].join(
    "\u0000"
  );
}

/** What a list item says of its round, when its machine said (#17943). */
export type ItemRound = Partial<Pick<DecisionQuestionListItem, "replyMode" | "closedReason">>;

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
      // An answer or a person's follow-up: the list doesn't say which.
      return "Waiting to be typed in";
    case "needs-attention":
      return standing.deliveryStatus === "delivery-uncertain"
        ? "May or may not have been delivered"
        : "Delivery stopped and needs attention";
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
    case "needs-attention":
      // Its group's bar says it needs attention; the row says what stopped.
      return standing.deliveryStatus === "delivery-uncertain"
        ? "May not have been delivered"
        : "Delivery stopped";
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
    "standing" | "inbox" | "expiresAt" | "replyMode" | "closedReason"
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

/** A Remote Host's question while its Host isn't connected: as it last reported it (#17943). */
export function staleNote(item: Pick<DecisionQuestionListItem, "remoteHost">): string | null {
  const host = item.remoteHost;
  return host !== undefined && !host.connected ? `${host.name} away, as last reported` : null;
}

/**
 * What the shown question's warning says while delivery needs a person: only
 * what was recorded, since the list can't say whether an answer or a
 * follow-up stopped, nor who sent it.
 */
export function attentionText(
  standing: DecisionQuestionStanding,
  round: Pick<ItemRound, "closedReason"> = {}
): string {
  const uncertain =
    standing.kind === "needs-attention" && standing.deliveryStatus === "delivery-uncertain";
  // Closed without an answer (#17943): what stopped is the notice saying so, unless a
  // follow-up's delivery did, which the list can't tell apart, so both are named.
  const closing = closingNotice(round.closedReason ?? null);
  if (closing !== null) {
    return uncertain
      ? `The notice that ${closing}, or a follow-up, may or may not have been typed into the terminal. Check it there before anything is sent again.`
      : `The notice that ${closing}, or a follow-up, was recorded, but typing it into the terminal stopped. Choose what happens to it.`;
  }
  return uncertain
    ? "An answer or follow-up may or may not have been typed into the terminal. Check it there before anything is sent again."
    : "An answer or follow-up was recorded, but typing it into the terminal stopped. Choose what happens to it.";
}

/** What a closing notice tells the agent, as the attention callout names it. */
function closingNotice(reason: ItemRound["closedReason"] | null): string | null {
  switch (reason) {
    case "expired":
      return "the question expired unanswered";
    case "declined":
      return "you declined it";
    case "never-published":
      return "it never reached the relay";
    default:
      return null;
  }
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
 * Where the question was asked, as the row's quiet line names it: the project,
 * then the worktree unless it is only the project's own folder again.
 */
export function whereFacts(project: string | null, worktree: string | null): string[] {
  if (project !== null && worktree !== null && sameName(project, worktree)) return [project];
  return [project, worktree].filter((part) => part !== null);
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

/** Where the question was asked, as the row names it: the agent, then its project and worktree. */
export function originFacts(parts: {
  agent: string;
  project: string | null;
  worktree: string | null;
}): string[] {
  return [parts.agent, ...whereFacts(parts.project, parts.worktree)];
}

/** What the inbox says above its groups, or null when nothing needs saying. */
export function emptyText(groups: readonly InboxGroup[]): string | null {
  return groups.length === 0
    ? "When an agent asks for your input through Decisions, the question shows up here and on your phone."
    : null;
}

/** The question chosen in the inbox, and where it stood in the list when chosen. */
export interface InboxChoice {
  key: string;
  index: number;
}

/**
 * The question the inbox shows: the one chosen while it is still listed, else
 * the one that took its place, else the first of the pane that opened the
 * inbox, else the first listed. Null for an empty list.
 */
export function resolveSelection(
  ordered: readonly DecisionQuestionListItem[],
  chosen: InboxChoice | null,
  openerTerminalId: string | null
): DecisionQuestionListItem | null {
  if (ordered.length === 0) return null;
  if (chosen !== null) {
    const kept = ordered.find((item) => referenceKey(item.reference) === chosen.key);
    return kept ?? ordered[Math.min(chosen.index, ordered.length - 1)]!;
  }
  if (openerTerminalId !== null) {
    const own = ordered.find((item) => item.reference.terminalId === openerTerminalId);
    if (own !== undefined) return own;
  }
  return ordered[0]!;
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
    text: "Not connected to the relay. These are the questions this computer already holds; new ones, answers and dismissals wait until it reconnects.",
  };
}
