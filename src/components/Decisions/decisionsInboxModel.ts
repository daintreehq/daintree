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

/**
 * What the Decisions inbox (#17231) says about the questions this computer
 * holds: which group each is in, in what order, and its state in the words
 * the pane's chip uses. Only what the list recorded, never a reading of what
 * the agent is doing.
 */

export type InboxGroupId = "needs-you" | "delivering" | "attention" | "cleared" | "history";

export interface InboxGroup {
  id: InboxGroupId;
  title: string;
  items: DecisionQuestionListItem[];
}

const GROUP_TITLES: Record<InboxGroupId, string> = {
  "needs-you": "Needs you",
  delivering: "Being delivered",
  attention: "Needs attention",
  cleared: "Cleared",
  history: "History",
};

const GROUP_ORDER: readonly InboxGroupId[] = [
  "needs-you",
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
 * Cleared, still answerable, until it asks something new.
 */
export function inboxGroupOf(
  item: Pick<DecisionQuestionListItem, "standing" | "inbox">
): InboxGroupId {
  const group = groupOf(item.standing);
  return group === "needs-you" && item.inbox?.cleared === true ? "cleared" : group;
}

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

/** What a cleared question's row says: it still waits for the agent, just not on the person. */
export const CLEARED_NOTE = "Cleared on this computer";

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

/** When a closed question last moved: when it settled, else when it was asked. */
function closedAt(item: DecisionQuestionListItem): number {
  const settled = epoch(item.settledAt);
  return settled === Number.NEGATIVE_INFINITY ? epoch(item.askedAt) : settled;
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
    const id = inboxGroupOf(item);
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

/** The question's state, in the chip's words. One sentence, sentence case, no period. */
export function standingText(standing: DecisionQuestionStanding): string {
  switch (standing.kind) {
    case "waiting":
      return standing.reason === "open"
        ? "Waiting for an answer, here or on your phone"
        : "Answered; the agent asked for a reply";
    case "queued":
      return "Queued to send; you can answer it here";
    case "send-failed":
      return "Couldn't be sent";
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
          return "Cancelled";
        case "expired":
          return "Expired unanswered";
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
export function rowNote(standing: DecisionQuestionStanding): string | null {
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
      return standing.outcome === "answered" && !standing.handled ? null : standingText(standing);
    default:
      return standingText(standing);
  }
}

/** `rowNote`, for a row that may have been cleared (#17895): that is what sets it apart then. */
export function inboxRowNote(
  item: Pick<DecisionQuestionListItem, "standing" | "inbox">
): string | null {
  return inboxGroupOf(item) === "cleared" ? CLEARED_NOTE : rowNote(item.standing);
}

/** How close a deadline has to be before a waiting row names it. */
export const EXPIRY_SOON_MS = 24 * 60 * 60 * 1000;

/** Whether a question that still waits closes soon enough for its row to say so. */
export function expiresSoon(
  item: Pick<DecisionQuestionListItem, "expiresAt" | "standing">,
  nowMs: number
): boolean {
  // An open or queued question's own deadline; a reply asked for after an answer isn't bound by it.
  const asks =
    item.standing.kind === "queued" ||
    (item.standing.kind === "waiting" && item.standing.reason === "open");
  if (!asks || item.expiresAt === null) return false;
  const at = Date.parse(item.expiresAt);
  return !Number.isNaN(at) && at > nowMs && at - nowMs <= EXPIRY_SOON_MS;
}

/**
 * What the shown question's warning says while delivery needs a person: only
 * what was recorded, since the list can't say whether an answer or a
 * follow-up stopped, nor who sent it.
 */
export function attentionText(standing: DecisionQuestionStanding): string {
  return standing.kind === "needs-attention" && standing.deliveryStatus === "delivery-uncertain"
    ? "An answer or follow-up may or may not have been typed into the terminal. Check it there before anything is sent again."
    : "An answer or follow-up was recorded, but typing it into the terminal stopped. Choose what happens to it.";
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
