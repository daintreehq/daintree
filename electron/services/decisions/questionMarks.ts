import type {
  DecisionQuestionListItem,
  DecisionQuestionReference,
  MarkDecisionQuestionsPayload,
} from "../../../shared/types/decisionsQuestion.js";
import type { MetaStore } from "./attentionList.js";
import { deadlineElapsed } from "../../../shared/utils/decisionDeadline.js";

/**
 * What the person did with each question's ask on this computer (#17895):
 * seen, cleared or both, at the ask they did it at. Kept in the owner store's
 * meta table, so it goes with the rest of Decisions' local data, and never
 * sent anywhere: the relay, the phone, a Host and the agent see none of it.
 */
export const QUESTION_MARKS_META_KEY = "daintree:question-marks";

export interface QuestionMark {
  hostId: string;
  questionId: string;
  ask: string | null;
  seen: boolean;
  cleared: boolean;
}

/** Marks by `markKey`. */
export type QuestionMarks = ReadonlyMap<string, QuestionMark>;

/** A question by the machine that asked it and its id: a move to another terminal keeps its mark. */
export function markKey(
  reference: Pick<DecisionQuestionReference, "hostId" | "questionId">
): string {
  return JSON.stringify([reference.hostId, reference.questionId]);
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function markOf(value: unknown): QuestionMark | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { hostId, questionId, ask, seen, cleared } = value as Record<string, unknown>;
  if (!boundedId(hostId) || !boundedId(questionId)) return null;
  if (ask !== null && !boundedId(ask)) return null;
  if (typeof seen !== "boolean" || typeof cleared !== "boolean" || (!seen && !cleared)) return null;
  return { hostId, questionId, ask, seen, cleared };
}

/** The record as stored. A damaged record, or a damaged mark in it, hides nothing. */
export function parseQuestionMarks(text: string | null): Map<string, QuestionMark> {
  const marks = new Map<string, QuestionMark>();
  if (text === null) return marks;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return marks;
  }
  const entries =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { marks?: unknown }).marks
      : undefined;
  if (!Array.isArray(entries)) return marks;
  for (const entry of entries) {
    const mark = markOf(entry);
    if (mark !== null) marks.set(markKey(mark), mark);
  }
  return marks;
}

export function serializeQuestionMarks(marks: QuestionMarks): string {
  const entries = [...marks.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, { hostId, questionId, ask, seen, cleared }]) => ({
      hostId,
      questionId,
      ask,
      seen,
      cleared,
    }));
  return JSON.stringify({ marks: entries });
}

/**
 * The record in `store`. A failed read rejects rather than reading as no
 * marks, so a write made after it can never replace the marks it missed.
 */
export async function readQuestionMarks(store: MetaStore): Promise<Map<string, QuestionMark>> {
  return parseQuestionMarks(await store.getMeta(QUESTION_MARKS_META_KEY));
}

/** Whether the question is in Needs you: waiting for the person, or queued to be sent. */
function inNeedsYou(item: DecisionQuestionListItem): boolean {
  return item.standing.kind === "waiting" || item.standing.kind === "queued";
}

/**
 * The list with what each question in Needs you asks now, and the person's
 * mark on that ask when they made one. `asks` names each question's ask by
 * `markKey`; one it doesn't name, a Host's from before #17895, asks for the
 * reply its agent asked for, else for the question alone.
 */
export function withInbox(
  questions: readonly DecisionQuestionListItem[],
  asks: ReadonlyMap<string, string | null>,
  marks: QuestionMarks
): DecisionQuestionListItem[] {
  return questions.map((item) => {
    if (!inNeedsYou(item)) return item;
    const key = markKey(item.reference);
    const known = asks.get(key);
    const ask = known !== undefined ? known : item.replyRequest;
    const mark = marks.get(key);
    const held = mark !== undefined && mark.ask === ask;
    return {
      ...item,
      inbox: { ask, seen: held && mark.seen, cleared: held && mark.cleared },
    };
  });
}

/**
 * Each terminal's questions in Needs you that the person hasn't cleared at
 * the ask they show now, read as the inbox reads them (`withInbox`): a mark
 * made at an earlier ask clears nothing. `questions` are one machine's own,
 * asked from `hostId`, with `asks` naming each one's current ask by question
 * id. Seen alone still counts: it answers nothing. Given the time, one whose
 * deadline passed by this computer's clock doesn't count either: the inbox
 * has it awaiting an update, no longer waiting on the person (#17943).
 */
export function unclearedQuestionsByTerminal(
  questions: readonly DecisionQuestionListItem[],
  hostId: string,
  asks: ReadonlyMap<string, string | null>,
  marks: QuestionMarks,
  nowMs: number | null = null
): Map<string, number> {
  const byKey = new Map<string, string | null>();
  for (const [questionId, ask] of asks) byKey.set(markKey({ hostId, questionId }), ask);
  const counts = new Map<string, number>();
  for (const item of withInbox(questions, byKey, marks)) {
    if (item.inbox === undefined || item.inbox.cleared) continue;
    if (nowMs !== null && deadlineElapsed(item, nowMs)) continue;
    const { terminalId } = item.reference;
    counts.set(terminalId, (counts.get(terminalId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether the list leaves `mark` standing. This computer's own list is whole,
 * so one of its questions no longer listed has gone for good. A Host's can be
 * missing for a while (its link down, its list not read yet), so its mark
 * stays until the list shows the question over. A different ask proves the
 * mark stale only when it was reported (`reported`): a Host from before
 * #17895 says only which questions wait for a reply, so its open question's
 * ask is a guess. A stopped delivery can stand over a question that still
 * waits, and its mark waits with it.
 */
function stillHolds(
  mark: QuestionMark,
  item: DecisionQuestionListItem | undefined,
  ownHostId: string | null,
  reported: boolean
): boolean {
  if (item === undefined) return mark.hostId !== ownHostId;
  if (item.inbox !== undefined) return item.inbox.ask === mark.ask || !reported;
  return item.standing.kind === "needs-attention";
}

/**
 * `record` with the person's `payload` applied, each question only while
 * `list` (as published, with `inbox`) shows it in Needs you at the ask it was
 * shown with, and every mark the list proves stale let go. `reported` names,
 * by `markKey`, the questions whose ask was reported rather than guessed, as
 * `withInbox` took them. `marked` counts the questions the payload changed.
 */
export function applyQuestionMarks(
  record: QuestionMarks,
  list: readonly DecisionQuestionListItem[],
  payload: MarkDecisionQuestionsPayload,
  ownHostId: string | null,
  reported: ReadonlyMap<string, string | null>
): { marks: Map<string, QuestionMark>; marked: number } {
  const listed = new Map(list.map((item) => [markKey(item.reference), item]));
  const marks = new Map<string, QuestionMark>();
  for (const [key, mark] of record) {
    if (stillHolds(mark, listed.get(key), ownHostId, reported.has(key))) marks.set(key, mark);
  }
  let marked = 0;
  for (const { reference, ask } of payload.questions) {
    const key = markKey(reference);
    const inbox = listed.get(key)?.inbox;
    if (inbox === undefined || inbox.ask !== ask) continue;
    // A mark kept at another ask (one only guessed) says nothing about this one.
    const held = marks.get(key);
    const before =
      held !== undefined && held.ask === ask
        ? held
        : {
            hostId: reference.hostId,
            questionId: reference.questionId,
            ask,
            seen: false,
            cleared: false,
          };
    const seen = before.seen || payload.action === "seen";
    const cleared =
      payload.action === "clear" ? true : payload.action === "restore" ? false : before.cleared;
    if (seen === before.seen && cleared === before.cleared) continue;
    marked += 1;
    if (seen || cleared) marks.set(key, { ...before, seen, cleared });
    else marks.delete(key);
  }
  return { marks, marked };
}
