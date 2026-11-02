import {
  batchNotices,
  formatAnswerNotice,
  parseAnswers,
  type AnswerEntry,
  type LocalStore,
  type OpenAnswerEntry,
  type QuestionRow,
} from "@daintreehq/decisions-client";
import type { DecisionsAnswerPreview } from "../../../shared/types/decisionsAttention.js";
import { parseAnswerNotice, renderCopiedAnswer, sanitizeAnswerText } from "./answerNotice.js";

/**
 * The answers a person has marked handled (#16020), by question, at the
 * answer revision they saw. Kept in the store's own meta table, so it goes
 * with the rest of Decisions' local data; a correction (a later revision)
 * needs a person again.
 */
export const HANDLED_ANSWERS_META_KEY = "daintree:handled-answers";

type MetaStore = Pick<LocalStore, "getMeta" | "setMeta">;

export type HandledAnswers = ReadonlyMap<string, number>;

const QUESTION_ID = /^[A-Za-z0-9_-]{8,80}$/;

export async function readHandledAnswers(store: MetaStore): Promise<Map<string, number>> {
  const handled = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse((await store.getMeta(HANDLED_ANSWERS_META_KEY)) ?? "{}");
  } catch {
    // A damaged record hides nothing: every answer that needs a person shows.
    return handled;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return handled;
  for (const [questionId, revision] of Object.entries(parsed)) {
    if (QUESTION_ID.test(questionId) && Number.isSafeInteger(revision)) {
      handled.set(questionId, revision as number);
    }
  }
  return handled;
}

/**
 * Records `row`'s current answer as handled, and lets go of every record
 * whose question no longer needs a person, so the record never outgrows the
 * list it hides things from.
 */
export async function markAnswerHandled(
  store: MetaStore & Pick<LocalStore, "listQuestions">,
  row: QuestionRow
): Promise<void> {
  const handled = await readHandledAnswers(store);
  const waiting = new Set(
    (await store.listQuestions()).filter(needsAttention).map((q) => q.question_id)
  );
  const next: Record<string, number> = {};
  for (const [questionId, revision] of handled) {
    if (waiting.has(questionId)) next[questionId] = revision;
  }
  next[row.question_id] = answerRevision(row);
  await store.setMeta(HANDLED_ANSWERS_META_KEY, JSON.stringify(next));
}

/** Delivery stopped at a point where a person decides what happens next. Imported history never does. */
export function needsAttention(row: QuestionRow): boolean {
  return (
    !row.history_only &&
    (row.delivery_status === "needs-attention" || row.delivery_status === "delivery-uncertain")
  );
}

/** The newest answer revision the row holds, or 0 before any arrived. */
export function answerRevision(row: QuestionRow): number {
  let revision = 0;
  for (const entry of parseAnswers(row.answers_json)) revision = Math.max(revision, entry.revision);
  return revision;
}

export function isHandled(row: QuestionRow, handled: HandledAnswers): boolean {
  return needsAttention(row) && handled.get(row.question_id) === answerRevision(row);
}

/** The rows as panes, Canopy and the list see them: without what a person marked handled. */
export function withoutHandled(
  rows: readonly QuestionRow[],
  handled: HandledAnswers
): QuestionRow[] {
  return handled.size === 0 ? [...rows] : rows.filter((row) => !isHandled(row, handled));
}

/** What would be typed in, the delivery engine's own test: marked for delivery and not yet delivered. */
export function pendingEntries(row: QuestionRow): AnswerEntry[] {
  return parseAnswers(row.answers_json)
    .filter((entry) => entry.deliver && !entry.delivered)
    .sort((a, b) => a.revision - b.revision);
}

/** As much as typing it would keep: the comment cap of the typed block. */
const PREVIEW_TEXT_CHARS = 4_000;
const QUESTION_CHARS = 240;

/** One line of a question, as data: controls gone, cut to fit a row. */
export function questionLine(question: string): string | null {
  const first = question.split(/\r\n?|\n|\u2028|\u2029/).find((line) => line.trim() !== "");
  if (first === undefined) return null;
  const line = sanitizeAnswerText(first, QUESTION_CHARS);
  return line === "" ? null : line;
}

/**
 * The answer a person would act on: the newest one still waiting to be
 * typed in. An expiry notice isn't an answer, and shows nothing.
 */
export function answerPreviewOf(opened: readonly OpenAnswerEntry[]): DecisionsAnswerPreview | null {
  const answer = [...opened].reverse().find((entry) => entry.kind === "answer");
  if (answer === undefined) return null;
  const text =
    answer.text.trim() === "" ? null : sanitizeAnswerText(answer.text, PREVIEW_TEXT_CHARS);
  return {
    source: answer.source === "proxy" ? "proxy" : "human",
    choices: answer.choices
      .map((choice) => sanitizeAnswerText((choice.label ?? choice.id).replace(/\s+/g, " "), 120))
      .filter((choice) => choice !== ""),
    text: text === "" ? null : text,
    correction: answer.correction,
    answeredAt: answer.created_at,
  };
}

/**
 * The delimited block for `row`'s waiting answers, as the delivery engine
 * would type them, for a person to paste in themselves: built by the
 * library's own formatter, checked against its exact shape, and rendered
 * again without an injection marker. Null when there is nothing to copy.
 */
export function copiedAnswerText(
  row: Pick<QuestionRow, "question_id" | "alias">,
  opened: readonly OpenAnswerEntry[]
): string | null {
  if (opened.length === 0) return null;
  const blocks = opened.map((entry, index) =>
    formatAnswerNotice({
      kind: entry.kind,
      questionId: row.question_id,
      alias: row.alias,
      revision: entry.revision,
      source: entry.source === "proxy" ? "proxy" : "human",
      choices: entry.choices,
      comment: entry.text,
      correction: entry.correction,
      ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
      ...(entry.model_id ? { modelId: entry.model_id } : {}),
      // Never shown: the copy is rendered without it.
      injectionId: `copied-${index.toString().padStart(4, "0")}`,
    })
  );
  const text = batchNotices(blocks, Number.MAX_SAFE_INTEGER)[0];
  const parsed = text === undefined ? null : parseAnswerNotice(text);
  return parsed === null ? null : renderCopiedAnswer(parsed);
}

/**
 * Codes for a run that's no longer there, the ones a resume answers. Any
 * other reason (the answer didn't fit, typing was refused) isn't a missing
 * agent, so resuming one wouldn't help.
 */
const RESUMABLE_REASONS: ReadonlySet<string> = new Set([
  "relaunched",
  "pane_gone",
  "generation_mismatch",
  "session_mismatch",
  "resume_host_unreachable",
  "resume_host_unreadable",
  "resume_unknown_project",
  "resume_panel_limit",
  "resume_missing_cli",
  "resume_spawn_failed",
  "resume_timeout",
  "resume_exited",
  "resume_closed",
  "resume_no_bearer",
  "resume_target_changed",
  "resume_ended",
  "resume_failed",
  "resume_wrong_worktree",
]);

export function resumableReason(code: string | null): boolean {
  return code !== null && RESUMABLE_REASONS.has(code);
}
