import { deadlineMs, expiryText, withinAday } from "@/components/Decisions/decisionDeadline";
import { CLEARED_NOTE, ELAPSED_NOTE } from "@/components/Decisions/decisionsInboxModel";
import type { PaneDecisionState } from "@shared/types/decisions";
import {
  deliveryAttentionText,
  deliveryReasonText,
  deliverySubjectOf,
  deliverySubjectPlural,
  deliveryUncertainText,
  type DeliverySubject,
} from "@shared/utils/decisionsDeliveryReasons";
import { pluralize } from "@/lib/pluralize";

/**
 * What the pane's Decisions chip says, worked out from what main observed.
 * Every sentence is an observation about a question, an answer or this
 * terminal — never a reading of what the agent is doing.
 */

export type DecisionItemKind =
  | "attention"
  | "uncertain"
  | "answer"
  | "expired"
  | "never-published"
  | "open"
  | "queued"
  | "dismissing"
  | "cancelling";

/**
 * What an answer for this pane waits on before it's typed in (#16282): a
 * draft in this view's hybrid input, an empty composer for an agent whose CLI
 * takes a line mid-turn, or the next prompt of one whose CLI doesn't.
 */
export type PaneWait = "draft" | "composer" | "prompt";

/** Where an answer or expiry notice waits before it can be typed in. */
export type DecisionWaitFor = PaneWait | "host";

/** The pane's wait from what this view observes of it. */
export function paneWaitOf(pane: { hasDraft: boolean; queuesInput: boolean }): PaneWait {
  if (pane.hasDraft) return "draft";
  return pane.queuesInput ? "composer" : "prompt";
}

/**
 * Whether anything the chip says turns on the pane's wait: a question still
 * out and not past its deadline by the clock at `nowMs`, or an answer or
 * expiry notice waiting to be typed in. Only then does the chip need to read
 * the drafts that every keystroke rewrites.
 */
export function readsPaneWait(
  state: PaneDecisionState | null,
  nowMs: number | null = null
): boolean {
  return (
    state !== null &&
    (state.waitingAnswers.length > 0 ||
      state.openQuestions.some((question) => !pastDeadline(question.expiresAt, nowMs)))
  );
}

/** Its deadline passed by this computer's clock at `nowMs`; never without a clock. */
function pastDeadline(expiresAt: string | null, nowMs: number | null): boolean {
  const at = deadlineMs(expiresAt);
  return nowMs !== null && at !== null && at <= nowMs;
}

const PANE_WAITS: readonly PaneWait[] = ["draft", "composer", "prompt"];

/** How each wait finishes a sentence: "…typing it in {once the composer is empty}". */
const WAIT_PHRASES: Record<PaneWait, string> = {
  draft: "once the draft here is sent or cleared",
  composer: "once the composer is empty",
  prompt: "at the agent's next prompt",
};

export interface DecisionItem {
  questionId: string;
  /** `q-42`, the name the agent was given. */
  label: string;
  kind: DecisionItemKind;
  /** One sentence, sentence case, no period. */
  status: string;
  /** What of the question needs a person, for an item that does; null otherwise. */
  subject: DeliverySubject | null;
  /** Why delivery stopped, when the library recorded a code Daintree knows. */
  reason: string | null;
  /** For an answer or expiry notice: what it waits for before it's typed in. */
  waitsFor: DecisionWaitFor | null;
  /** Epoch ms, for an open or queued question. */
  askedAt: number | null;
  expiresAt: number | null;
  /**
   * For an open or queued question (#18053): its deadline passed by this
   * computer's clock, though nothing has confirmed it closed yet, so it waits
   * on an update rather than on the person.
   */
  elapsed: boolean;
  /**
   * For an open or queued question: the person cleared what it asks now from
   * Needs you on this computer (#17895). It still waits for the agent, and
   * stays answerable, just not on the person.
   */
  cleared: boolean;
  /** An open or queued question whose round only offers advice. */
  advisory: boolean;
}

/**
 * Why an open or queued question no longer waits on the person, as the inbox
 * groups it: cleared first, then past its deadline. Null while it still does.
 */
export function setAsideOf(item: DecisionItem): "cleared" | "awaiting" | null {
  return item.cleared ? "cleared" : item.elapsed ? "awaiting" : null;
}

/**
 * Worst first: what needs a person, then what is about to be typed, then what
 * is still out, and last what no longer waits on the person.
 */
const KIND_ORDER: Record<DecisionItemKind, number> = {
  attention: 0,
  uncertain: 1,
  answer: 2,
  expired: 3,
  "never-published": 3,
  open: 4,
  queued: 5,
  dismissing: 6,
  cancelling: 7,
};

const SET_ASIDE_ORDER = { awaiting: 8, cleared: 9 } as const;

function orderOf(item: DecisionItem): number {
  const setAside = setAsideOf(item);
  return setAside === null ? KIND_ORDER[item.kind] : SET_ASIDE_ORDER[setAside];
}

const NO_IDS: ReadonlySet<string> = new Set();

function aliasLabel(alias: number): string {
  return `q-${alias}`;
}

function epoch(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * What sets an open or queued question aside (#18053): the clock its
 * deadline is read against, and the ids of the pane's questions the person
 * cleared on this computer. Without them, every question still waits.
 */
export interface SetAsideReading {
  nowMs: number | null;
  cleared: ReadonlySet<string>;
}

const NOTHING_SET_ASIDE: SetAsideReading = { nowMs: null, cleared: NO_IDS };

/**
 * Every outstanding question for the pane, worst first, then in the order
 * they were asked. `cancelling` holds the questions a person withdrew here
 * that main has committed but the relay hasn't confirmed, and `dismissing`
 * those a person dismissed here (#17239) whose decline is under way or was
 * taken: each stays listed, so, until the pane's state no longer lists it as
 * waiting. An open or queued question the person cleared, or whose deadline
 * passed by `setAside.nowMs`, is listed last, as the inbox lists it.
 */
export function decisionItems(
  state: PaneDecisionState,
  wait: PaneWait = "composer",
  cancelling: ReadonlySet<string> = NO_IDS,
  dismissing: ReadonlySet<string> = NO_IDS,
  setAside: SetAsideReading = NOTHING_SET_ASIDE
): DecisionItem[] {
  const items: DecisionItem[] = [];
  for (const entry of state.needsAttention) {
    const uncertain = entry.deliveryStatus === "delivery-uncertain";
    // A Host from before the subject named it simply reads it as the answer.
    const subject = entry.subject ?? "answer";
    items.push({
      questionId: entry.questionId,
      label: aliasLabel(entry.alias),
      kind: uncertain ? "uncertain" : "attention",
      status: uncertain ? deliveryUncertainText(subject) : deliveryAttentionText(subject),
      subject,
      // Read in the terminal that asked, so it is "this terminal" here.
      reason: deliveryReasonText(entry.reason, subject, "here"),
      waitsFor: null,
      askedAt: null,
      expiresAt: null,
      elapsed: false,
      cleared: false,
      advisory: false,
    });
  }
  for (const entry of state.waitingAnswers) {
    const expired = entry.kind === "expired";
    const unsent = entry.kind === "never-published";
    const hostAway = entry.deliveryStatus === "pending-host";
    const telling = hostAway
      ? "telling the agent when this terminal's host is back"
      : `telling the agent ${WAIT_PHRASES[wait]}`;
    items.push({
      questionId: entry.questionId,
      label: aliasLabel(entry.alias),
      kind: entry.kind,
      status: unsent
        ? `Deadline passed before it reached the relay, ${telling}`
        : expired
          ? `Expired unanswered, ${telling}`
          : hostAway
            ? "Answer received, delivering when this terminal's host is back"
            : `Answer received, typing it in ${WAIT_PHRASES[wait]}`,
      subject: null,
      reason: null,
      waitsFor: hostAway ? "host" : wait,
      askedAt: null,
      expiresAt: null,
      elapsed: false,
      cleared: false,
      advisory: false,
    });
  }
  for (const question of state.openQuestions) {
    const queued = question.status === "queued";
    const withdrawn = cancelling.has(question.questionId);
    const declined = !withdrawn && dismissing.has(question.questionId);
    // A dismissal or withdrawal under way says so whatever the clock or a clear says.
    const asking = !withdrawn && !declined;
    const elapsed = asking && pastDeadline(question.expiresAt, setAside.nowMs);
    const cleared = asking && setAside.cleared.has(question.questionId);
    items.push({
      questionId: question.questionId,
      label: aliasLabel(question.alias),
      kind: withdrawn ? "cancelling" : declined ? "dismissing" : queued ? "queued" : "open",
      // Answered from the question's view as well as on a phone (#17102).
      status: withdrawn
        ? "Cancelling, waiting for the relay to confirm"
        : declined
          ? "Dismissed here, waiting for it to close"
          : cleared
            ? CLEARED_NOTE
            : elapsed
              ? ELAPSED_NOTE
              : queued
                ? "Queued to send; you can answer it here"
                : "Waiting for an answer, here or on your phone",
      subject: null,
      reason: null,
      waitsFor: null,
      askedAt: epoch(question.askedAt),
      expiresAt: epoch(question.expiresAt),
      elapsed,
      cleared,
      advisory: question.replyMode === "advisory",
    });
  }
  const aliasOf = (item: DecisionItem) => Number(item.label.slice(2));
  return items.sort((a, b) => orderOf(a) - orderOf(b) || aliasOf(a) - aliasOf(b));
}

function isAttention(item: DecisionItem): boolean {
  return item.kind === "attention" || item.kind === "uncertain";
}

/** Still waiting for an answer, so a person may dismiss it. */
export function isCancellable(item: DecisionItem): boolean {
  return item.kind === "open" || item.kind === "queued";
}

/**
 * Why some rows offer no Dismiss: an answered question's answer is already
 * the agent's, and an expired one is over. Null when every row is waiting,
 * or already being dismissed or withdrawn.
 */
export function cancelNote(items: readonly DecisionItem[]): string | null {
  // A held follow-up puts a question still waiting under attention too; its waiting row offers Dismiss.
  const waiting = new Set(
    items
      .filter(
        (item) => isCancellable(item) || item.kind === "cancelling" || item.kind === "dismissing"
      )
      .map((item) => item.questionId)
  );
  // A stopped timeout notice is an expired question's, not an answered one's (#18054).
  const noticeStopped = (item: DecisionItem) =>
    isAttention(item) && item.subject?.startsWith("timeout notice") === true;
  const answered = items.some(
    (item) =>
      (item.kind === "answer" || (isAttention(item) && !noticeStopped(item))) &&
      !waiting.has(item.questionId)
  );
  // Past its deadline either way: one that never reached the relay is over too.
  const expired = items.some(
    (item) =>
      item.kind === "expired" ||
      item.kind === "never-published" ||
      (noticeStopped(item) && !waiting.has(item.questionId))
  );
  if (answered && expired) return "Answered and expired questions can't be dismissed";
  if (answered) return "Answered questions can't be dismissed";
  if (expired) return "Expired questions can't be dismissed";
  return null;
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
 * isn't "asked" — or, for several, how many questions, and how many of them
 * Daintree is about to type in, since that is what to know before typing here.
 * A question set aside (#18053) stays out of that while anything else is
 * listed, so it never presents the pane as waiting on the person.
 */
export function chipLabel(items: readonly DecisionItem[]): ChipLabel {
  const live = items.filter((item) => setAsideOf(item) === null);
  if (live.length === 0) return setAsideLabel(items);
  if (live.length === 1) return itemLabel(live[0]!);
  const text = pluralize(questionCount(live), "question");
  const delivering = live.filter(isDelivering).length;
  if (delivering === 0) return { text, detail: null };
  if (delivering === live.length) return { text, detail: "delivering" };
  return { text, detail: `· ${delivering.toLocaleString()} delivering` };
}

/**
 * How many questions the items name: a held follow-up can list one question
 * twice, under attention and as still waiting.
 */
export function questionCount(items: readonly DecisionItem[]): number {
  return new Set(items.map((item) => item.questionId)).size;
}

/** The words for questions that all wait on something other than the person. */
function setAsideLabel(items: readonly DecisionItem[]): ChipLabel {
  if (items.length === 1) {
    const item = items[0]!;
    return {
      text: `${item.label} ${setAsideOf(item) === "cleared" ? "cleared" : "awaiting update"}`,
      detail: null,
    };
  }
  const cleared = items.filter((item) => setAsideOf(item) === "cleared").length;
  const awaiting = items.length - cleared;
  if (awaiting === 0) return { text: `${cleared.toLocaleString()} cleared`, detail: null };
  return {
    text: `${awaiting.toLocaleString()} awaiting update`,
    detail: cleared === 0 ? null : `· ${cleared.toLocaleString()} cleared`,
  };
}

function itemLabel(item: DecisionItem): ChipLabel {
  switch (item.kind) {
    case "answer":
      return { text: `${item.label} delivering`, detail: null };
    case "expired":
      return { text: `${item.label} expired`, detail: null };
    case "never-published":
      return { text: `${item.label} never sent`, detail: null };
    case "queued":
      return { text: `${item.label} queued`, detail: null };
    case "dismissing":
      return { text: `${item.label} dismissing`, detail: null };
    case "cancelling":
      return { text: `${item.label} cancelling`, detail: null };
    default:
      return { text: item.label, detail: null };
  }
}

/** What the items needing attention are, as plurals: "Answers", "Answers and follow-ups". */
function attentionNouns(items: readonly DecisionItem[]): string {
  const held = items.filter(isAttention).map((item) => item.subject ?? "answer");
  const nouns = [
    held.some((subject) => subject.includes("answer")) ? "answers" : null,
    held.some((subject) => subject.includes("follow-up")) ? "follow-ups" : null,
    held.some((subject) => subject.startsWith("timeout notice")) ? "timeout notices" : null,
  ].filter((noun) => noun !== null);
  const list =
    nouns.length > 1 ? `${nouns.slice(0, -1).join(", ")} and ${nouns.at(-1)}` : nouns[0]!;
  return list.charAt(0).toUpperCase() + list.slice(1);
}

/**
 * What the popover's closing lines promise, in the order they apply: answers
 * that will be typed in on their own, and answers that won't.
 */
export function deliveryNotes(
  items: readonly DecisionItem[],
  wait: PaneWait = "composer"
): string[] {
  const notes: string[] = [];
  // A question being dismissed or withdrawn has no answer coming, nor one past its deadline.
  const waitsHere = items.some(
    (item) =>
      !isAttention(item) &&
      item.kind !== "cancelling" &&
      item.kind !== "dismissing" &&
      !item.elapsed &&
      item.waitsFor !== "host"
  );
  if (waitsHere) notes.push(`Answers are typed in here ${WAIT_PHRASES[wait]}`);
  if (items.some((item) => item.waitsFor === "host")) {
    notes.push("Answers for a host that's away are typed in once it's back");
  }
  if (needsAttention(items)) {
    notes.push(`${attentionNouns(items)} that need attention aren't typed in on their own`);
  }
  return notes;
}

/**
 * How to answer, while any question still waits for one: its row opens the
 * composer. One the person cleared still can be; one past its deadline can't,
 * and nothing invites an answer once every such deadline has passed.
 */
export function answerNote(items: readonly DecisionItem[], nowMs = 0): string | null {
  return items.some((item) => isCancellable(item) && !item.elapsed && !deadlinePassed(item, nowMs))
    ? "Open a question to answer it here"
    : null;
}

/** An open or queued question whose deadline passed by this computer's clock. */
export function deadlinePassed(item: DecisionItem, nowMs: number): boolean {
  return isCancellable(item) && item.expiresAt !== null && item.expiresAt <= nowMs;
}

/**
 * What an open or queued question's popover row adds about its deadline
 * (#17943, #18054), as the inbox's row says it: nothing until the deadline is
 * within a day, then that it is advice only (when it is), when to reply by in
 * this computer's time, and how long is left; or that it passed with nothing
 * confirming how it closed yet. Null for one that never expires, and for every
 * other row. Only the expanded popover says it: the chip stays compact.
 */
export function deadlineNote(item: DecisionItem, nowMs: number): string | null {
  if ((item.kind !== "open" && item.kind !== "queued") || item.expiresAt === null) return null;
  // Its status already says so when that is what set it aside.
  if (setAsideOf(item) === "awaiting") return null;
  if (deadlinePassed(item, nowMs)) return ELAPSED_NOTE;
  return withinAday(item.expiresAt, nowMs)
    ? expiryText(item.expiresAt, nowMs, item.advisory ? "advisory" : "blocking")
    : null;
}

/**
 * The one status line a list of questions all share, said once above it
 * rather than on every row: several open questions, or several queued ones.
 * Null for a single question, a mixed list, every other kind, a list with a
 * question set aside (#18053), which keeps its own quieter status, and a list
 * in which a deadline has passed, whose row then says so rather than that it
 * can still be answered.
 */
export function sharedWaitingStatus(items: readonly DecisionItem[], nowMs: number): string | null {
  if (items.length < 2) return null;
  const first = items[0]!;
  if (first.kind !== "open" && first.kind !== "queued") return null;
  if (items.some((item) => item.kind !== first.kind || setAsideOf(item) !== null)) return null;
  return items.some((item) => deadlinePassed(item, nowMs)) ? null : first.status;
}

/** One item's whole sentence, naming the question: what the tooltip and the button's name say. */
export function itemSentence(item: DecisionItem): string {
  switch (setAsideOf(item)) {
    case "cleared":
      return item.elapsed
        ? `Question ${item.label} was cleared on this computer; its deadline passed`
        : `Question ${item.label} was cleared on this computer`;
    case "awaiting":
      return `Question ${item.label}'s deadline passed, awaiting an update`;
  }
  switch (item.kind) {
    case "open":
      return `Question ${item.label} is waiting for an answer, here or on your phone`;
    case "queued":
      return `Question ${item.label} is queued to send; you can answer it here`;
    case "dismissing":
      return `Question ${item.label} was dismissed here, waiting for it to close`;
    case "cancelling":
      return `Question ${item.label} is being cancelled, waiting for the relay to confirm`;
    case "answer":
    case "expired":
    case "never-published":
      return `${item.status} (${item.label})`;
    case "attention": {
      const subject = item.subject ?? "answer";
      const needs = deliverySubjectPlural(subject) ? "need" : "needs";
      return `${deliverySubjectOf(subject, item.label)} ${needs} attention`;
    }
    case "uncertain":
      return `${deliverySubjectOf(item.subject ?? "answer", item.label)} may or may not have been delivered`;
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
  ...PANE_WAITS.map((wait) => ({
    matches: (item: DecisionItem) => item.kind === "answer" && item.waitsFor === wait,
    one: `answered, typing in ${WAIT_PHRASES[wait]}`,
    many: `answered, typing in ${WAIT_PHRASES[wait]}`,
  })),
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
    matches: (item) => item.kind === "never-published",
    one: "past its deadline before it reached the relay",
    many: "past their deadlines before they reached the relay",
  },
  {
    matches: (item) => item.kind === "open" && setAsideOf(item) === null,
    one: "waiting for an answer",
    many: "waiting for an answer",
  },
  {
    matches: (item) => item.kind === "queued" && setAsideOf(item) === null,
    one: "queued to send",
    many: "queued to send",
  },
  { matches: (item) => item.kind === "dismissing", one: "dismissing", many: "dismissing" },
  { matches: (item) => item.kind === "cancelling", one: "cancelling", many: "cancelling" },
  {
    matches: (item) => setAsideOf(item) === "awaiting",
    one: "past its deadline, awaiting an update",
    many: "past their deadlines, awaiting an update",
  },
  {
    matches: (item) => setAsideOf(item) === "cleared",
    one: "cleared on this computer",
    many: "cleared on this computer",
  },
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
  return `${pluralize(questionCount(items), "Decisions question")}: ${parts.join("; ")}`;
}
