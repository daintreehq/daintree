import {
  parseAnswers,
  type AnswerEntry,
  type AuditEntry,
  type InjectionIntent,
  type QuestionRow,
} from "@daintreehq/decisions-client";
import { reasonOf } from "./paneDecisionState.js";
import { timeoutNoticeOf, type TimeoutNotice } from "./questionRound.js";

/**
 * A content-free trail of each timeout notice on its way into the terminal
 * that asked (#17944), kept in the store's own audit table beside the
 * library's records, in the same write as the change it describes: when the
 * closing of its round was observed, each attempt to type it and the pane it
 * was for, an attempt that ended before anything was typed (a busy pane, a
 * hold for the ledger, a pane that couldn't take it), and what became of it,
 * with the library's code for why. Ids, rounds, times, states and codes
 * only, each checked for its shape: never the question's words, an answer,
 * or the agent's plan.
 */
export const NOTICE_TRAIL_EVENT = "notice.trail";

type Step = "observed" | "attempted" | "untyped" | "superseded" | TimeoutNotice["delivery"];

/** The intent a write settled, when it settled one: the attempt a delivered or uncertain step is for. */
export type SettledIntent = Pick<InjectionIntent, "injection_id" | "state">;

type Intent = Pick<InjectionIntent, "injection_id" | "message_id" | "answer_revision" | "pane_id">;

interface Facts {
  notice: TimeoutNotice;
  /** The notice's own entry, whose marks say which attempt typed it, may have, or was refused. */
  recorded: AnswerEntry | undefined;
  reason: string | null;
}

/** A row with a closure entry a timeout notice could come from; anything else is skipped unparsed. */
function mayHoldNotice(row: QuestionRow | null): row is QuestionRow {
  return (
    row !== null &&
    !row.history_only &&
    (row.answers_json.includes('"expired"') || row.answers_json.includes('"unpublished"'))
  );
}

function factsOf(row: QuestionRow | null): Facts | null {
  if (!mayHoldNotice(row)) return null;
  const entries = parseAnswers(row.answers_json);
  const notice = timeoutNoticeOf(row, entries);
  if (notice === null) return null;
  const stopped = notice.delivery === "needs-attention" || notice.delivery === "uncertain";
  return {
    notice,
    recorded: entries.find((e) => e.entry_id === notice.entryId),
    reason: stopped ? reasonOf(row.error_code) : null,
  };
}

/** What the notice said of the plan as recorded with it, not as any reader would say it now. */
function recordedPlan(entry: AnswerEntry | undefined): string | null {
  if (entry === undefined) return null;
  const recorded = entry.advisory_disposition;
  if (recorded === "fallback-due" || recorded === "fallback-withheld") return recorded;
  return entry.fallback_due === true ? "fallback-due" : null;
}

/** An id as the library mints them; anything else is left out rather than copied. */
function idOf(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null;
}

function attemptOf(id: string | null | undefined): Record<string, string> {
  const safe = idOf(id);
  return safe === null ? {} : { attempt: safe };
}

/**
 * What proves the attempt behind a stop: the notice's own entry (the
 * attempt that typed it, that may have, or that an admitted write was
 * refused), else the intent the same write settled. A stop with neither (a
 * pane that went away after an earlier attempt ended untyped) names no
 * attempt, since the row's latest isn't evidence of what stopped it.
 */
function evidenceOf(facts: Facts, settled: SettledIntent | undefined): Record<string, string> {
  const { recorded, notice } = facts;
  switch (notice.delivery) {
    case "delivered":
      return attemptOf(
        recorded?.injection_id ?? (settled?.state === "typed" ? settled.injection_id : null)
      );
    case "uncertain":
      return attemptOf(
        recorded?.uncertain_injection_id ??
          (settled?.state === "uncertain" ? settled.injection_id : null)
      );
    case "needs-attention":
      return recorded?.write_refused === true ? { refused: "admitted-write" } : {};
    default:
      return {};
  }
}

function entry(
  at: string,
  row: QuestionRow,
  facts: Facts,
  step: Step,
  extra: Record<string, string> = {}
): AuditEntry {
  const { notice, recorded } = facts;
  return {
    at,
    event: NOTICE_TRAIL_EVENT,
    question_id: row.question_id,
    requirement: row.requirement,
    result: step,
    detail: {
      kind: notice.kind,
      revision: notice.revision,
      deadline: notice.deadline,
      plan: recordedPlan(recorded),
      pane: idOf(row.origin.pane_id),
      ...extra,
    },
  };
}

/**
 * What a write to a question changed of its current timeout notice, as trail
 * entries: none for a write that changed nothing of it. `settled`, the intent
 * the same write settled, if it settled one.
 */
export function noticeTrailOf(
  before: QuestionRow | null,
  after: QuestionRow,
  at: string,
  settled?: SettledIntent
): AuditEntry[] {
  const was = factsOf(before);
  const now = factsOf(after);
  if (now === null) {
    // A reopen moved the round on before its notice was typed: it never will be.
    if (was === null || before === null || was.notice.delivery === "delivered") return [];
    return [entry(at, before, was, "superseded")];
  }
  const out: AuditEntry[] = [];
  const fresh = was === null || was.notice.entryId !== now.notice.entryId;
  if (fresh) out.push(entry(at, after, now, "observed"));
  const moved =
    was === null || fresh
      ? now.notice.delivery !== "pending"
      : now.notice.delivery !== was.notice.delivery || now.reason !== was.reason;
  if (moved) {
    out.push(
      entry(at, after, now, now.notice.delivery, {
        ...(now.reason !== null ? { reason: now.reason } : {}),
        ...evidenceOf(now, settled),
      })
    );
  }
  return out;
}

/** The intent's step for `row`'s timeout notice while that is still to be typed, at its round; null otherwise. */
function intentStep(
  row: QuestionRow | null,
  intent: Intent,
  at: string,
  step: "attempted" | "untyped"
): AuditEntry | null {
  if (intent.message_id !== null || row === null) return null;
  const facts = factsOf(row);
  if (facts === null || facts.notice.delivery === "delivered") return null;
  if (facts.notice.revision !== intent.answer_revision) return null;
  const pane = idOf(intent.pane_id);
  return entry(at, row, facts, step, {
    ...attemptOf(intent.injection_id),
    ...(pane !== null ? { pane } : {}),
  });
}

/**
 * The trail entry for an attempt at `row`'s timeout notice, as its intent is
 * stored before anything touches the terminal (#17944), so a crash before
 * the row's own attempt fields are written still leaves it.
 */
export function noticeAttemptOf(
  row: QuestionRow | null,
  intent: Intent,
  at: string
): AuditEntry | null {
  return intentStep(row, intent, at, "attempted");
}

/**
 * The trail entry for an attempt at `row`'s timeout notice that ended before
 * anything was typed (#17944): the destination was busy or couldn't take it,
 * or the ledger may still hold a later event of its round. The store calls it
 * only for an intent closed straight from being written: one released from
 * `uncertain` after a reopen may have reached the terminal.
 */
export function noticeUntypedOf(
  row: QuestionRow | null,
  intent: Intent,
  at: string
): AuditEntry | null {
  return intentStep(row, intent, at, "untyped");
}
