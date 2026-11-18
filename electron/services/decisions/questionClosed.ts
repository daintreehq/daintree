import { parseAnswers, type AnswerEntry, type QuestionRow } from "@daintreehq/decisions-client";
import type { DecisionQuestionClosedReason } from "../../../shared/types/decisionsQuestion.js";

/**
 * The person's decline from their phone or tablet (#17234) that closed the
 * question, as the library's bridge reads one: a cancelled question with a
 * decline at its revision, since only a reopen changes a cancelled question
 * and it moves the revision on. Undefined for a question withdrawn from the
 * desktop, or not closed.
 */
export function declineOf(
  row: Pick<QuestionRow, "local_status" | "question_revision" | "answers_json">
): AnswerEntry | undefined {
  if (row.local_status !== "cancelled") return undefined;
  return parseAnswers(row.answers_json).find(
    (entry) => entry.kind === "declined" && entry.revision === row.question_revision
  );
}

/**
 * Why a closed question has no answer, as the library's bridge reads it for
 * `get_decision`: a cancelled one was declined by the person or withdrawn
 * from the desktop, an expired one expired. Null for any other status.
 */
export function closedReasonOf(
  row: Pick<QuestionRow, "local_status" | "question_revision" | "answers_json">
): DecisionQuestionClosedReason | null {
  if (row.local_status === "expired") return "expired";
  if (row.local_status !== "cancelled") return null;
  return declineOf(row) === undefined ? "withdrawn" : "declined";
}
