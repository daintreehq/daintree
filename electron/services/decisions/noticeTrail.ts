import {
  parseAnswers,
  type AnswerEntry,
  type AuditEntry,
  type InjectionIntent,
  type QuestionRow,
} from "@daintreehq/decisions-client";
import { timeoutNoticeOf, type TimeoutNotice } from "./questionRound.js";

/**
 * A content-free trail of each timeout notice on its way into the terminal
 * that asked (#17944), kept in the store's own audit table beside the
 * library's records, in the same write as the change it describes: when the
 * closing of its round was observed, each attempt to type it and the pane it
 * was for, an attempt that ended before anything was typed (a busy pane, a
 * hold for the ledger, a pane that couldn't take it), and what became of it,
 * with the library's code for why. Ids, rounds, times, states and codes only: never the
 * question's words, an answer, or the agent's plan.
 */
export const NOTICE_TRAIL_EVENT = "notice.trail";

type Step = "observed" | "attempted" | "untyped" | "superseded" | TimeoutNotice["delivery"];

interface Facts {
  notice: TimeoutNotice;
  /** The notice's own entry, whose marks say which attempt typed it, may have, or was refused. */
  recorded: AnswerEntry | undefined;
  reason: string | null;
  /** The row's latest attempt, which describes its answers: the notice's only once a write sets it after the closing. */
  attempt: string | null;
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
  const notice = timeoutNoticeOf(row);
  if (notice === null) return null;
  const stopped = notice.delivery === "needs-attention" || notice.delivery === "uncertain";
  return {
    notice,
    recorded: parseAnswers(row.answers_json).find((e) => e.entry_id === notice.entryId),
    reason: stopped ? (row.error_code ?? "unspecified") : null,
    attempt: row.last_injection_id ?? null,
  };
}

/**
 * What the notice's own entry proves of the attempt behind a step: the one
 * that typed it, the one that may have, or that an admitted write was
 * refused. A stop with neither (a pane that went away after an earlier
 * attempt ended untyped) names no attempt, since the row's latest isn't
 * evidence that one was refused.
 */
function evidenceOf(facts: Facts): Record<string, string | number | null> {
  const { recorded, notice } = facts;
  if (recorded === undefined) return {};
  if (notice.delivery === "delivered" && recorded.injection_id) {
    return { attempt: recorded.injection_id };
  }
  if (notice.delivery === "uncertain" && recorded.uncertain_injection_id) {
    return { attempt: recorded.uncertain_injection_id };
  }
  if (notice.delivery === "needs-attention" && recorded.write_refused === true) {
    return { refused: "admitted-write" };
  }
  return {};
}

/** What the notice said of the plan as recorded with it, not as any reader would say it now. */
function recordedPlan(entry: AnswerEntry | undefined): string | null {
  if (entry === undefined) return null;
  if (entry.advisory_disposition !== undefined) return entry.advisory_disposition;
  return entry.fallback_due === true ? "fallback-due" : null;
}

function entry(
  at: string,
  row: QuestionRow,
  facts: Facts,
  step: Step,
  extra: Record<string, string | number | null> = {}
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
      pane: row.origin.pane_id,
      ...extra,
    },
  };
}

/**
 * What a write to a question changed of its current timeout notice, as trail
 * entries: none for a write that changed nothing of it. `before` is null for
 * a row just stored.
 */
export function noticeTrailOf(
  before: QuestionRow | null,
  after: QuestionRow,
  at: string
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
  // The row's attempt fields describe its answers; one carried over from before the closure isn't the notice's.
  if (
    !fresh &&
    was !== null &&
    now.notice.delivery !== "delivered" &&
    now.attempt !== null &&
    now.attempt !== was.attempt
  ) {
    out.push(entry(at, after, now, "attempted", { attempt: now.attempt }));
  }
  const moved =
    was === null || fresh
      ? now.notice.delivery !== "pending"
      : now.notice.delivery !== was.notice.delivery || now.reason !== was.reason;
  if (moved) {
    out.push(
      entry(at, after, now, now.notice.delivery, {
        ...(now.reason !== null ? { reason: now.reason } : {}),
        ...evidenceOf(now),
      })
    );
  }
  return out;
}

/**
 * The trail entry for an attempt at `row`'s timeout notice that ended before
 * anything was typed (#17944): the destination was busy or couldn't take it,
 * or the ledger may still hold a later event of its round. Null for any
 * other intent.
 */
export function noticeUntypedOf(
  row: QuestionRow | null,
  intent: Pick<InjectionIntent, "injection_id" | "message_id" | "answer_revision" | "pane_id">,
  at: string
): AuditEntry | null {
  if (intent.message_id !== null) return null;
  const facts = factsOf(row);
  if (facts === null || row === null) return null;
  if (facts.notice.delivery === "delivered" || facts.notice.revision !== intent.answer_revision) {
    return null;
  }
  return entry(at, row, facts, "untyped", { attempt: intent.injection_id, pane: intent.pane_id });
}
