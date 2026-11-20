import {
  closureInForce,
  currentDisposition,
  parseAnswers,
  unpublishedPlanDue,
  unsupportedEntry,
  type AnswerEntry,
  type QuestionRow,
} from "@daintreehq/decisions-client";
import {
  ADVISORY_ROUND_REVISION,
  advisoryContentIssue,
  replyModeOf,
  type DecisionContentV1,
} from "@daintreehq/decisions-protocol";
import type {
  DecisionClosureNotice,
  DecisionQuestionClosedReason,
  DecisionReplyMode,
} from "../../../shared/types/decisionsQuestion.js";
import { closedReasonOf } from "./questionClosed.js";

/**
 * What a question's current round is, read from its row the way the library's
 * `get_decision` reads it (#17943): its mode, how it closed without an answer,
 * and how far that closing notice got into the asking terminal. Only the
 * envelope's clear AAD and the answers' clear bookkeeping are read; nothing
 * sealed is opened here.
 */

type RoundRow = Pick<
  QuestionRow,
  | "content_sealed"
  | "question_revision"
  | "answers_json"
  | "local_status"
  | "delivery_status"
  | "history_only"
>;

/**
 * Whether this Daintree delivers advisory outcomes, and whether its policy
 * allows advice: both off until #17940 and #17941 enable them. A notice not
 * yet typed follows them, so on this build an advisory expiry's notice is the
 * ordinary expiry, which lets no plan go ahead.
 */
const ADVISORY_HOST = { outcomes: false, allowed: false } as const;

/** The envelope's AAD as published, or null when it can't be read as one. */
function envelopeOf(row: Pick<RoundRow, "content_sealed">): { aad: unknown } | null {
  const sealed = row.content_sealed;
  // Every question before advisory deadlines lacks the key: no parse for those.
  if (!sealed || !sealed.includes('"reply_mode"')) return null;
  try {
    const parsed: unknown = JSON.parse(sealed);
    return typeof parsed === "object" && parsed !== null && "aad" in parsed
      ? (parsed as { aad: unknown })
      : null;
  } catch {
    return null;
  }
}

/** The mode the question was published with, from its envelope's AAD. */
function publishedMode(row: Pick<RoundRow, "content_sealed">): DecisionReplyMode {
  const envelope = envelopeOf(row);
  if (envelope === null || typeof envelope.aad !== "object" || envelope.aad === null) {
    return "blocking";
  }
  return replyModeOf(envelope as Parameters<typeof replyModeOf>[0]);
}

/**
 * The current round's mode, as the bridge reads it: advisory only while the
 * question is still in the round it was published in as advisory. Every
 * answer moves the revision on and is kept with its revision; a reopen moves
 * it without one, so a revision the answers don't account for is a reopened
 * round, which always waits.
 */
export function replyModeOfRow(
  row: Pick<RoundRow, "content_sealed" | "question_revision">,
  entries: readonly AnswerEntry[]
): DecisionReplyMode {
  if (publishedMode(row) !== "advisory") return "blocking";
  const answered = new Set(
    entries.filter((entry) => entry.kind === "answer").map((entry) => entry.revision)
  ).size;
  return row.question_revision <= answered ? "advisory" : "blocking";
}

/** Advisory content the protocol refuses, apart from any plan's own words. */
export const PLAN_REFUSED: unique symbol = Symbol("plan-refused");

/**
 * The plan an advisory round states, from content just opened for this row:
 * only for an envelope published as advisory at the advisory round, whose
 * content the protocol lets stand as advisory, while the question is still in
 * that round. Null for a blocking round, which may carry anything there
 * without meaning, and for a reopened one. `refused` for advisory content the
 * protocol refuses (an approval, or no plan): such a question is malformed,
 * and is never shown as optional nor with a plan it dropped.
 */
export function verifiedPlan(
  row: Pick<RoundRow, "content_sealed" | "question_revision">,
  entries: readonly AnswerEntry[],
  content: Pick<DecisionContentV1, "kind" | "planned_fallback">
): string | null | typeof PLAN_REFUSED {
  const envelope = envelopeOf(row);
  if (envelope === null || publishedMode(row) !== "advisory") return null;
  const aad = envelope.aad as { revision?: unknown };
  if (aad.revision !== ADVISORY_ROUND_REVISION) return null;
  if (advisoryContentIssue({ envelope: envelope as never }, content) !== null) return PLAN_REFUSED;
  if (replyModeOfRow(row, entries) !== "advisory") return null;
  return content.planned_fallback ?? null;
}

/**
 * Why the question closed without an answer, as the bridge reads it: the
 * person's decline, a withdrawal, an expiry, or a deadline that passed before
 * it ever reached the relay. Null otherwise, a relay's refusal included.
 */
export function closedReasonOfRow(
  row: Pick<RoundRow, "local_status" | "question_revision" | "answers_json">,
  entries: readonly AnswerEntry[]
): DecisionQuestionClosedReason | null {
  if (row.local_status === "publish-failed") {
    return entries.some((entry) => entry.kind === "unpublished") ? "never-published" : null;
  }
  return closedReasonOf(row);
}

/** The last entry `matches` takes, or undefined. */
function lastOf(
  entries: readonly AnswerEntry[],
  matches: (entry: AnswerEntry) => boolean
): AnswerEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (matches(entries[index]!)) return entries[index];
  }
  return undefined;
}

/** The notice that closed the current round without an answer; undefined for none. */
function closureEntry(row: RoundRow, entries: readonly AnswerEntry[]): AnswerEntry | undefined {
  if (row.local_status === "publish-failed") {
    return lastOf(entries, (entry) => entry.kind === "unpublished");
  }
  return lastOf(
    entries,
    (entry) =>
      (entry.kind === "expired" || entry.kind === "declined") &&
      unsupportedEntry(entry) === null &&
      closureInForce(entry, row)
  );
}

/**
 * How far the notice got. A write that may have reached the terminal stays
 * uncertain whatever happened since: marking it handled stops it being typed
 * again, but can't say what the first write typed.
 */
function noticeDelivery(entry: AnswerEntry, row: RoundRow): DecisionClosureNotice["delivery"] {
  if (entry.delivered) return "delivered";
  if (entry.uncertain_injection_id !== undefined) return "uncertain";
  if (row.delivery_status === "delivery-uncertain") return "uncertain";
  if (!entry.deliver) return "stopped";
  if (row.delivery_status === "needs-attention") return "needs-attention";
  return "pending";
}

/**
 * What the closing notice says of the plan, for an advisory round: what it
 * said once typed (or possibly typed), else what it would say as this
 * Daintree stands now, never upgraded. An advisory expiry recorded without a
 * disposition was typed as the ordinary expiry, which lets no plan go ahead.
 */
function noticeDisposition(
  entry: AnswerEntry,
  delivery: DecisionClosureNotice["delivery"],
  mode: DecisionReplyMode
): DecisionClosureNotice["disposition"] {
  if (mode !== "advisory" || entry.kind === "declined") return null;
  const said = delivery === "delivered" || delivery === "uncertain";
  if (entry.kind === "unpublished") {
    // Untyped, a notice whose plan was due may still have an uncertain write the row doesn't
    // show (the bridge reads the store's intents for it): what it says is unknown, not withheld.
    if (!said && entry.fallback_due === true) return null;
    return unpublishedPlanDue(entry, said, ADVISORY_HOST) ? "fallback-due" : "fallback-withheld";
  }
  const recorded = entry.advisory_disposition;
  if (recorded === undefined) return "fallback-withheld";
  return said ? recorded : (currentDisposition(recorded, ADVISORY_HOST) ?? recorded);
}

/**
 * The closing notice of the current round and how far it got into the asking
 * terminal. Null while nothing closed it that way (open, answered,
 * withdrawn), and for imported history, which this computer never delivered.
 */
export function closureNoticeOf(
  row: RoundRow,
  entries: readonly AnswerEntry[],
  mode: DecisionReplyMode = replyModeOfRow(row, entries)
): DecisionClosureNotice | null {
  if (row.history_only) return null;
  const entry = closureEntry(row, entries);
  if (entry === undefined) return null;
  const delivery = noticeDelivery(entry, row);
  return { delivery, disposition: noticeDisposition(entry, delivery, mode) };
}

/** The round facts a list item and a read both carry. */
export interface QuestionRound {
  replyMode: DecisionReplyMode;
  closedReason: DecisionQuestionClosedReason | null;
  closureNotice: DecisionClosureNotice | null;
}

export function roundOf(row: RoundRow, entries = parseAnswers(row.answers_json)): QuestionRound {
  // Read once: the envelope is parsed for its mode only when it can be advisory.
  const replyMode = replyModeOfRow(row, entries);
  return {
    replyMode,
    closedReason: closedReasonOfRow(row, entries),
    closureNotice: closureNoticeOf(row, entries, replyMode),
  };
}
