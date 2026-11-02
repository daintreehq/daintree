import type { PaneDecisionState } from "@shared/types/decisions";
import { pluralize } from "@/lib/pluralize";

/**
 * What the pane's Decisions chip says, worked out from what main observed.
 * Every sentence is an observation about a question, an answer or this
 * terminal — never a reading of what the agent is doing.
 */

export type DecisionItemKind = "attention" | "uncertain" | "answer" | "expired" | "open" | "queued";

/** Where an answer or expiry notice waits before it can be typed in. */
export type DecisionWaitFor = "idle" | "host";

export interface DecisionItem {
  questionId: string;
  /** `q-42`, the name the agent was given. */
  label: string;
  kind: DecisionItemKind;
  /** One sentence, sentence case, no period. */
  status: string;
  /** Why delivery stopped, when the library recorded a code Daintree knows. */
  reason: string | null;
  /** For an answer or expiry notice: what it waits for before it's typed in. */
  waitsFor: DecisionWaitFor | null;
  /** Epoch ms, for an open or queued question. */
  askedAt: number | null;
  expiresAt: number | null;
}

/** Worst first: what needs a person, then what is about to be typed, then what is still out. */
const KIND_ORDER: Record<DecisionItemKind, number> = {
  attention: 0,
  uncertain: 1,
  answer: 2,
  expired: 3,
  open: 4,
  queued: 5,
};

/**
 * The library's codes for a delivery that stopped, in words. A code not here
 * still shows the item; only the explanation is left out.
 */
const REASONS: Record<string, string> = {
  relaunched: "This terminal was relaunched after the question was asked.",
  pane_gone: "The terminal that asked is gone.",
  generation_mismatch: "This terminal was restarted after the question was asked.",
  session_mismatch: "A different agent session is running here now.",
  resume_wrong_worktree: "The resumed agent opened in a different worktree.",
  inject_rejected: "This terminal refused the answer.",
  unavailable_unknown_reason: "This terminal refused the answer.",
  answer_unreadable: "The answer couldn't be decrypted on this computer.",
  no_target: "Nothing matches the terminal that asked.",
  target_mismatch: "Nothing matches the terminal that asked.",
  choice_required: "The answer doesn't fit what the question allows.",
  text_not_allowed: "The answer doesn't fit what the question allows.",
  too_many_choices: "The answer doesn't fit what the question allows.",
  unknown_option: "The answer doesn't fit what the question allows.",
  proxy_forbidden: "The question needs a person's answer, not a proxy's.",
  inject_ambiguous: "Typing it in was interrupted, so it isn't typed again on its own.",
  inject_threw: "Typing it in was interrupted, so it isn't typed again on its own.",
  crash_unreconciled: "Daintree stopped while typing it in, so it isn't typed again on its own.",
  delivered_without_proof: "Typing it in wasn't confirmed, so it isn't typed again on its own.",
  invalid_inject_result: "Typing it in wasn't confirmed, so it isn't typed again on its own.",
  // Why resuming the agent to type it in didn't happen (`daintreeResumeAdapter.ts`).
  resume_unsupported_agent: "This agent can't be resumed to type it in.",
  resume_other_host: "The terminal that asked is on another host.",
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
  resume_ended: "Resuming stopped before the answer was typed in.",
  resume_failed: "Resuming the agent failed.",
};

function aliasLabel(alias: number): string {
  return `q-${alias}`;
}

function epoch(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Every outstanding question for the pane, worst first, then in the order they were asked. */
export function decisionItems(state: PaneDecisionState): DecisionItem[] {
  const items: DecisionItem[] = [];
  for (const entry of state.needsAttention) {
    const uncertain = entry.deliveryStatus === "delivery-uncertain";
    items.push({
      questionId: entry.questionId,
      label: aliasLabel(entry.alias),
      kind: uncertain ? "uncertain" : "attention",
      status: uncertain ? "Answer may or may not have been delivered" : "Answer needs attention",
      reason: REASONS[entry.reason] ?? null,
      waitsFor: null,
      askedAt: null,
      expiresAt: null,
    });
  }
  for (const entry of state.waitingAnswers) {
    const expired = entry.kind === "expired";
    const hostAway = entry.deliveryStatus === "pending-host";
    items.push({
      questionId: entry.questionId,
      label: aliasLabel(entry.alias),
      kind: expired ? "expired" : "answer",
      status: expired
        ? hostAway
          ? "Expired unanswered, telling the agent when this terminal's host is back"
          : "Expired unanswered, telling the agent when this terminal is idle"
        : hostAway
          ? "Answer received, delivering when this terminal's host is back"
          : "Answer received, delivering when this terminal is idle",
      reason: null,
      waitsFor: hostAway ? "host" : "idle",
      askedAt: null,
      expiresAt: null,
    });
  }
  for (const question of state.openQuestions) {
    const queued = question.status === "queued";
    items.push({
      questionId: question.questionId,
      label: aliasLabel(question.alias),
      kind: queued ? "queued" : "open",
      status: queued ? "Queued to send" : "Waiting for an answer",
      reason: null,
      waitsFor: null,
      askedAt: epoch(question.askedAt),
      expiresAt: epoch(question.expiresAt),
    });
  }
  const aliasOf = (item: DecisionItem) => Number(item.label.slice(2));
  return items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || aliasOf(a) - aliasOf(b));
}

function isAttention(item: DecisionItem): boolean {
  return item.kind === "attention" || item.kind === "uncertain";
}

/** A person has to decide what happens to at least one answer. */
export function needsAttention(items: readonly DecisionItem[]): boolean {
  return items.some(isAttention);
}

/** An answer or expiry notice Daintree will type into this terminal on its own. */
function isDelivering(item: DecisionItem): boolean {
  return item.waitsFor !== null;
}

export interface ChipLabel {
  text: string;
  /** Said after `text` while the header has room for it; the tooltip always says it. */
  detail: string | null;
}

/**
 * The chip's words: the question's name, with what happened to it when that
 * isn't "asked" — or, for several, how many, and how many of them Daintree is
 * about to type in, since that is what to know before typing here.
 */
export function chipLabel(items: readonly DecisionItem[]): ChipLabel {
  if (items.length !== 1) {
    const text = items.length.toLocaleString();
    const delivering = items.filter(isDelivering).length;
    if (delivering === 0) return { text, detail: null };
    if (delivering === items.length) return { text, detail: "delivering" };
    return { text, detail: `· ${delivering.toLocaleString()} delivering` };
  }
  const item = items[0]!;
  switch (item.kind) {
    case "answer":
      return { text: `${item.label} delivering`, detail: null };
    case "expired":
      return { text: `${item.label} expired`, detail: null };
    case "queued":
      return { text: `${item.label} queued`, detail: null };
    default:
      return { text: item.label, detail: null };
  }
}

/**
 * What the popover's closing lines promise, in the order they apply: answers
 * that will be typed in on their own, and answers that won't.
 */
export function deliveryNotes(items: readonly DecisionItem[]): string[] {
  const notes: string[] = [];
  const waitsForIdle = items.some((item) => !isAttention(item) && item.waitsFor !== "host");
  if (waitsForIdle) notes.push("Answers are typed in here once this terminal is idle");
  if (items.some((item) => item.waitsFor === "host")) {
    notes.push("Answers for a host that's away are typed in once it's back");
  }
  if (needsAttention(items)) notes.push("Answers that need attention aren't typed in on their own");
  return notes;
}

/** One item's whole sentence, naming the question: what the tooltip and the button's name say. */
export function itemSentence(item: DecisionItem): string {
  switch (item.kind) {
    case "open":
      return `Question ${item.label} is waiting for an answer`;
    case "queued":
      return `Question ${item.label} is queued to send`;
    case "answer":
    case "expired":
      return `${item.status} (${item.label})`;
    case "attention":
      return `Answer to ${item.label} needs attention`;
    case "uncertain":
      return `Answer to ${item.label} may or may not have been delivered`;
  }
}

/**
 * What the whole chip says: one item's sentence, or for several a count and
 * how they break down, worst first.
 */
/** How the summary groups several questions, worst first; the phrase follows the count. */
const SUMMARY_GROUPS: Array<{
  matches: (item: DecisionItem) => boolean;
  one: string;
  many: string;
}> = [
  { matches: isAttention, one: "needs attention", many: "need attention" },
  {
    matches: (item) => item.kind === "answer" && item.waitsFor === "idle",
    one: "answered, delivering when this terminal is idle",
    many: "answered, delivering when this terminal is idle",
  },
  {
    matches: (item) => item.kind === "answer" && item.waitsFor === "host",
    one: "answered, delivering when this terminal's host is back",
    many: "answered, delivering when this terminal's host is back",
  },
  {
    matches: (item) => item.kind === "expired",
    one: "expired unanswered",
    many: "expired unanswered",
  },
  {
    matches: (item) => item.kind === "open",
    one: "waiting for an answer",
    many: "waiting for an answer",
  },
  { matches: (item) => item.kind === "queued", one: "queued to send", many: "queued to send" },
];

export function chipSummary(items: readonly DecisionItem[]): string {
  if (items.length === 1) return itemSentence(items[0]!);
  const parts: string[] = [];
  for (const group of SUMMARY_GROUPS) {
    const count = items.filter(group.matches).length;
    // A no-break space keeps each count on the line of the words it counts.
    if (count > 0) parts.push(pluralize(count, group.one, group.many).replace(" ", "\u00a0"));
  }
  // Semicolons, since one group's own words carry a comma.
  return `${pluralize(items.length, "Decisions question")}: ${parts.join("; ")}`;
}
