import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { basename } from "@shared/utils/path";
import type { DecisionsStatus } from "@shared/types/decisions";
import type {
  DecisionQuestionListItem,
  DecisionQuestionReference,
  DecisionQuestionStanding,
} from "@shared/types/decisionsQuestion";

/**
 * What the Decisions inbox (#17231) says about the questions this computer
 * holds: which group each is in, in what order, and its state in the words
 * the pane's chip uses. Only what the list recorded, never a reading of what
 * the agent is doing.
 */

export type InboxGroupId = "needs-you" | "delivering" | "attention" | "history";

export interface InboxGroup {
  id: InboxGroupId;
  title: string;
  items: DecisionQuestionListItem[];
}

const GROUP_TITLES: Record<InboxGroupId, string> = {
  "needs-you": "Needs you",
  delivering: "Being delivered",
  attention: "Needs attention",
  history: "History",
};

const GROUP_ORDER: readonly InboxGroupId[] = ["needs-you", "delivering", "attention", "history"];

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
 * the list's order, oldest first; history shows the most recently closed first.
 */
export function inboxGroups(questions: readonly DecisionQuestionListItem[]): InboxGroup[] {
  const byGroup = new Map<InboxGroupId, DecisionQuestionListItem[]>();
  for (const item of questions) {
    const id = groupOf(item.standing);
    const items = byGroup.get(id);
    if (items === undefined) byGroup.set(id, [item]);
    else items.push(item);
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
  return [parts.agent, parts.project, parts.worktree].filter((part) => part !== null);
}

/** What the inbox says above its groups, or null when nothing needs saying. */
export function emptyText(groups: readonly InboxGroup[]): string | null {
  return groups.length === 0
    ? "No questions yet. When an agent asks for your input through Decisions, it shows up here."
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
    text: "Not connected to the relay right now. These are the questions this computer already holds; new ones, answers and cancels wait until it reconnects.",
  };
}
