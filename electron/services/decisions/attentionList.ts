import {
  answeredOn,
  closureInForce,
  formatAnswerNotice,
  isClosure,
  isUndeliveredMessage,
  formatFollowupNotice,
  messageSentOn,
  noticeChunk,
  parseAnswers,
  parseMessages,
  type AnswerEntry,
  type LocalStore,
  type OpenAnswerEntry,
  type QuestionRow,
  type ResolvedPhoneImage,
  type StoredMessage,
} from "@daintreehq/decisions-client";
import type { PhoneImageReference } from "@daintreehq/decisions-protocol";
import { createHash } from "node:crypto";
import type { DecisionsAnswerPreview } from "../../../shared/types/decisionsAttention.js";
import {
  parseDecisionNotice,
  renderCopiedAnswer,
  sanitizeAnswerText,
  type DecisionBlock,
} from "./answerNotice.js";

/**
 * The answers a person has marked handled (#16020), by question, at the
 * answer revision they saw. Kept in the store's own meta table, so it goes
 * with the rest of Decisions' local data; a correction (a later revision)
 * needs a person again.
 */
export const HANDLED_ANSWERS_META_KEY = "daintree:handled-answers";

export type MetaStore = Pick<LocalStore, "getMeta" | "setMeta">;

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

/**
 * The person's follow-ups (#16231) delivery stopped on at a point where a
 * person decides, in thread order: the library holds each one on its own,
 * whatever became of the question's answer. One marked handled is no longer
 * delivered, so it isn't held either.
 */
export function heldFollowUps(row: QuestionRow): StoredMessage[] {
  if (row.history_only) return [];
  return parseMessages(row.messages_json)
    .filter(
      (message) =>
        message.side === "human" &&
        message.delivery?.deliver === true &&
        (message.delivery.status === "needs-attention" ||
          message.delivery.status === "delivery-uncertain")
    )
    .sort((a, b) => a.event_seq - b.event_seq);
}

/**
 * The question's answer needs a person, and they haven't marked it handled.
 * A question over without an answer never does (`closedUnanswered`).
 */
export function answerNeedsAttention(row: QuestionRow, handled: HandledAnswers): boolean {
  return (
    needsAttention(row) &&
    !closedUnanswered(row) &&
    !stoppedOnReplacedClosure(row) &&
    handled.get(row.question_id) !== answerRevision(row)
  );
}

/**
 * The question is over without an answer, and its closing notice is all that
 * delivery can have stopped on (#18021), so there is nothing for a person to
 * decide: the notice is news only for an agent still listening. It counts as
 * handled, so it shows nowhere a person acts and keeps nothing of the question
 * waiting, however its notice stopped; how far the notice got is still read
 * from the row on its own.
 *
 * - **Cancelled:** a person's decline (#17234) or a withdrawal. Either drops
 *   every answer and follow-up not yet typed, and a withdrawal leaves the
 *   stopped status of an answer nothing will type.
 * - **Expired, or never published:** only while the round's own notice is
 *   untyped, nothing else of the answer waits to be typed, the code is no
 *   answer's, and none of the person's follow-ups waits to be typed. While
 *   one does, the notice stays theirs to resolve with it, so the two go back
 *   in thread order (the library would hold one sequenced after it behind a
 *   stopped notice). A possibly typed write stays the person's while the row
 *   holds an untyped answer it could have been.
 */
export function closedUnanswered(row: QuestionRow): boolean {
  if (row.local_status === "cancelled") return true;
  if (row.local_status !== "expired" && row.local_status !== "publish-failed") return false;
  if (row.error_code !== null && ANSWER_CODES.has(row.error_code)) return false;
  const entries = parseAnswers(row.answers_json);
  if (!entries.some((entry) => roundNotice(entry, row) && !entry.delivered)) return false;
  // As the delivery engine's own test: a notice of a round since replaced is never typed.
  const live = pendingEntries(row).filter(
    (entry) => !isClosure(entry) || closureInForce(entry, row)
  );
  if (live.some((entry) => !roundNotice(entry, row))) return false;
  if (
    row.delivery_status === "delivery-uncertain" &&
    entries.some((entry) => !NOTICE_KINDS.has(entry.kind) && !entry.delivered)
  ) {
    return false;
  }
  return !parseMessages(row.messages_json).some(isUndeliveredMessage);
}

const NOTICE_KINDS: ReadonlySet<string> = new Set(["expired", "declined", "unpublished"]);

/** The notice that closed the row's current round at its deadline: its expiry, or that it never reached the relay. */
function roundNotice(entry: AnswerEntry, row: QuestionRow): boolean {
  if (row.local_status === "expired") return entry.kind === "expired" && closureInForce(entry, row);
  return (
    row.local_status === "publish-failed" &&
    entry.kind === "unpublished" &&
    entry.revision === row.question_revision
  );
}

/**
 * Codes for an answer the question can't take: never a closure notice's, so a
 * stall with one is an answer's, whatever entries the row holds.
 */
const ANSWER_CODES: ReadonlySet<string> = new Set([
  "answer_unreadable",
  "answer_unknown_kind",
  "answer_unknown_source",
  "choice_required",
  "text_not_allowed",
  "too_many_choices",
  "unknown_option",
  "proxy_forbidden",
]);

/**
 * Typing stopped on a closure notice whose round a reopen has since replaced
 * (#17944): the library withdraws the notice but leaves the row's stopped
 * status, and nothing of the answer waits to be typed any more, so there is
 * nothing for a person to decide. Only while every entry of the newest round
 * the row records is such a notice, untyped, and the code is no answer's. A
 * possibly typed write keeps the question uncertain until the library
 * releases it.
 */
export function stoppedOnReplacedClosure(row: QuestionRow): boolean {
  if (row.delivery_status !== "needs-attention" || pendingEntries(row).length > 0) return false;
  if (row.error_code !== null && ANSWER_CODES.has(row.error_code)) return false;
  const entries = parseAnswers(row.answers_json);
  if (entries.length === 0) return false;
  const newest = Math.max(...entries.map((entry) => entry.revision));
  return entries
    .filter((entry) => entry.revision === newest)
    .every((entry) => isClosure(entry) && !entry.delivered && !closureInForce(entry, row));
}

/** Its answer or a follow-up after it needs a person. */
export function threadNeedsAttention(row: QuestionRow, handled: HandledAnswers): boolean {
  return answerNeedsAttention(row, handled) || heldFollowUps(row).length > 0;
}

/** Its answer is handled, and no follow-up needs a person either. */
export function isHandled(row: QuestionRow, handled: HandledAnswers): boolean {
  return (
    needsAttention(row) &&
    // A reopened question whose old notice stopped is open again, not handled: it stays in every
    // feed. One closed again since (a withdrawal) is over, whatever notice its earlier round left.
    (closedUnanswered(row) || !stoppedOnReplacedClosure(row)) &&
    !answerNeedsAttention(row, handled) &&
    heldFollowUps(row).length === 0
  );
}

/**
 * What a person is asked about `row` now, as an opaque fixed-length digest
 * of ids and states only (#17944): the answer revision, every entry still to
 * be typed, the held follow-ups, the delivery status, the round, and the run
 * it goes to. An action confirmed against one token is refused once the row
 * asks something else, so a confirmation shown before a correction, a new
 * follow-up, a replaced round or a move from another window never acts on
 * what the person didn't see.
 */
export function attentionToken(row: QuestionRow, handled: HandledAnswers): string {
  const answerHeld = answerNeedsAttention(row, handled);
  const { origin } = row;
  const asked = JSON.stringify([
    answerHeld ? answerRevision(row) : null,
    answerHeld ? pendingEntries(row).map((entry) => entry.entry_id) : [],
    heldFollowUps(row).map((message) => [message.message_id, message.delivery?.status ?? null]),
    row.delivery_status,
    row.question_revision,
    [origin.host_id, origin.pane_id, origin.terminal_generation, origin.agent_incarnation],
  ]);
  return createHash("sha256").update(asked).digest("hex");
}

/** The rows as panes, Canopy and the list see them: without what a person marked handled. */
export function withoutHandled(
  rows: readonly QuestionRow[],
  handled: HandledAnswers
): QuestionRow[] {
  // A stopped decline is handled with nothing marked, so every read filters.
  return rows.filter((row) => !isHandled(row, handled));
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

const GENERIC_HEADINGS = new Set([
  "context",
  "question",
  "questions",
  "summary",
  "background",
  "overview",
  "details",
  "decision",
  "decision needed",
  "problem",
  "issue",
  "situation",
  "options",
  "tl;dr",
  "tldr",
]);

const LINE_SCAN_CHARS = 4_000;

/** Emphasis and links outside code spans; the line was already cut to a bounded length. */
function stripInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/(^|[^\w*_])(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\2(?![\w*_])/g, "$1$3")
    .replace(/(^|[^\w*_])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*_])/g, "$1$3");
}

/** A line's text without Markdown syntax: marks, emphasis, ticks and link syntax, keeping link labels. */
function stripMarkdown(raw: string): string {
  let line = sanitizeAnswerText(
    raw.trim().replace(/\t/g, " ").slice(0, LINE_SCAN_CHARS),
    LINE_SCAN_CHARS
  );
  line = unquote(line);
  if (/^(?:=+|(?:[-*_]\s*){3,})$/.test(line)) return "";
  line = line.replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, "");
  const heading = /^\s*#{1,6}(?:\s+|$)/.test(line);
  line = line.replace(/^\s*#{1,6}(?:\s+|$)/, "");
  if (heading) line = line.replace(/\s+#+\s*$/, "");
  let out = "";
  let last = 0;
  for (const span of line.matchAll(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g)) {
    out += stripInline(line.slice(last, span.index)) + span[2];
    last = span.index + span[0].length;
  }
  return (out + stripInline(line.slice(last))).trim();
}

function unquote(line: string): string {
  return line.replace(/^\s{0,3}(?:>\s*)+/, "");
}

/** The fence a line opens or closes, when it is one: a fence closed on its own line is inline code. */
function fenceOf(
  raw: string
): { char: string; length: number; bare: boolean; quoted: boolean } | null {
  const line = unquote(raw.slice(0, LINE_SCAN_CHARS)).trim();
  const marker = /^(?:`{3,}|~{3,})/.exec(line)?.[0];
  if (marker === undefined) return null;
  const rest = line.slice(marker.length);
  if (marker[0] === "`" && rest.includes(marker)) return null;
  return {
    char: marker[0]!,
    length: marker.length,
    bare: rest.trim() === "",
    quoted: unquote(raw) !== raw,
  };
}

function isGenericHeading(text: string): boolean {
  return GENERIC_HEADINGS.has(text.replace(/[\s:：.\-–—]+$/, "").toLowerCase());
}

/** One line of a question, as data: Markdown syntax and controls gone, cut to fit a row. */
export function questionLine(question: string): string | null {
  const lines = question.split(/\r\n?|\n|\u2028|\u2029/);
  // A fence that never closes is not a block: its text counts as the question's.
  const inside: boolean[] = [];
  let open: { char: string; length: number; quoted: boolean } | null = null;
  let opened = 0;
  for (const raw of lines) {
    const fence = fenceOf(raw);
    if (open === null) {
      inside.push(fence !== null);
      if (fence !== null) {
        open = fence;
        opened = inside.length - 1;
      }
    } else {
      inside.push(true);
      if (
        fence !== null &&
        fence.bare &&
        fence.char === open.char &&
        fence.quoted === open.quoted &&
        fence.length >= open.length
      ) {
        open = null;
      }
    }
  }
  if (open !== null) inside.fill(false, opened + 1);
  let first: string | undefined;
  for (const [index, raw] of lines.entries()) {
    if (inside[index] || raw.trim() === "" || fenceOf(raw) !== null) continue;
    const text = sanitizeAnswerText(stripMarkdown(raw), QUESTION_CHARS);
    if (text === "") continue;
    first ??= text;
    if (!isGenericHeading(text)) return text;
  }
  return first ?? null;
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

/** A held follow-up with its words opened, in memory only. */
export interface OpenFollowUp {
  message: StoredMessage;
  text: string;
  /** The photos it references, as the person attached them. */
  images?: PhoneImageReference[];
}

const seqOf = (entry: Pick<AnswerEntry, "event_seq">) => entry.event_seq ?? 0;

/**
 * The delimited blocks for `row`'s waiting answers and held follow-ups, in
 * thread order as the delivery engine would type them, for a person to paste
 * in themselves: built by the library's own formatter, checked against its
 * exact shape, and rendered again without an injection marker. `images`
 * lists each answer's or follow-up's photos (#16233), by entry or message id,
 * as they were stored for it. Null when there is nothing to copy.
 */
export function copiedAnswerText(
  row: Pick<QuestionRow, "question_id" | "alias" | "answers_json">,
  opened: readonly OpenAnswerEntry[],
  followUps: readonly OpenFollowUp[] = [],
  images: ReadonlyMap<string, ResolvedPhoneImage[]> = new Map()
): string | null {
  if (opened.length === 0 && followUps.length === 0) return null;
  // Never shown: the copy is rendered without it.
  const copyId = (index: number) => `copied-${index.toString().padStart(4, "0")}`;
  const answers = opened.map((entry, index) => ({
    seq: seqOf(entry),
    block: formatAnswerNotice({
      kind: entry.kind,
      questionId: row.question_id,
      alias: row.alias,
      revision: entry.revision,
      source: entry.source === "proxy" ? "proxy" : "human",
      ...(answeredOn(entry) === "computer" ? { onComputer: true } : {}),
      choices: entry.choices,
      comment: entry.text,
      correction: entry.correction,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
      ...(entry.model_id ? { modelId: entry.model_id } : {}),
      ...(images.has(entry.entry_id) ? { images: images.get(entry.entry_id) } : {}),
      injectionId: copyId(index),
    }),
  }));
  const given = parseAnswers(row.answers_json).filter((entry) => entry.kind === "answer");
  const messages = followUps.map(({ message, text }, index) => ({
    seq: message.event_seq,
    block: formatFollowupNotice({
      questionId: row.question_id,
      alias: row.alias,
      messageId: message.message_id,
      text,
      // As the delivery engine tells it: an answer came before it in the thread.
      answered: given.some((entry) => seqOf(entry) < message.event_seq),
      ...(messageSentOn(message) === "computer" ? { onComputer: true } : {}),
      ...(images.has(message.message_id) ? { images: images.get(message.message_id) } : {}),
      injectionId: copyId(opened.length + index),
    }),
  }));
  // Stable, so answers keep their own order among themselves.
  const blocks = [...answers, ...messages].sort((a, b) => a.seq - b.seq).map((b) => b.block);
  // Each on its own, so a long thread is never past what one typed chunk could hold.
  const parsed: DecisionBlock[] = [];
  for (const block of blocks) {
    const one = parseDecisionNotice(noticeChunk([block]));
    if (one === null) return null;
    parsed.push(...one);
  }
  return renderCopiedAnswer(parsed);
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
