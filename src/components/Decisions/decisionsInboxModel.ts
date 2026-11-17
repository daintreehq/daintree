import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { basename } from "@shared/utils/path";
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

/** Whether two references name the same question. */
export function sameReference(a: DecisionQuestionReference, b: DecisionQuestionReference): boolean {
  return referenceKey(a) === referenceKey(b);
}

/** The question's state, in the chip's words. One sentence, sentence case, no period. */
export function standingText(standing: DecisionQuestionStanding): string {
  switch (standing.kind) {
    case "waiting":
      return standing.reason === "open"
        ? "Waiting for an answer, here or on your phone"
        : "Answered; the agent's follow-up expects a reply";
    case "queued":
      return "Queued to send; you can answer it here";
    case "send-failed":
      return "Couldn't be sent";
    case "to-type":
      return "Answered, waiting to be typed in";
    case "needs-attention":
      return standing.deliveryStatus === "delivery-uncertain"
        ? "May or may not have been delivered"
        : "Delivery stopped and needs attention";
    case "settled":
      switch (standing.outcome) {
        case "answered":
          return standing.handled ? "Answered, marked handled" : "Answered and typed in";
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
export function originText(parts: {
  agent: string;
  project: string | null;
  worktree: string | null;
}): string {
  return [parts.agent, parts.project, parts.worktree].filter((part) => part !== null).join(" · ");
}

/** What the inbox says above its groups, or null when nothing needs saying. */
export function emptyText(groups: readonly InboxGroup[]): string | null {
  return groups.length === 0
    ? "No questions yet. When an agent asks for your input through Decisions, it shows up here."
    : null;
}
