import { decisionsClient } from "@/clients/decisionsClient";
import type {
  DecisionQuestionCancelResult,
  DecisionQuestionContentResult,
  DecisionQuestionImageResult,
  DecisionQuestionReference,
  DecisionQuestionSummary,
} from "@shared/types/decisionsQuestion";

/**
 * A question the question view reads, as it was opened: one of a pane's,
 * read from the machine that owns the pane for a view of its project, or one
 * named by its reference (#17229), read from this computer for any window.
 */
export type DecisionQuestionTarget =
  | { scope: "pane"; terminalId: string; questionId: string }
  | { scope: "reference"; reference: DecisionQuestionReference };

export function paneQuestion(terminalId: string, questionId: string): DecisionQuestionTarget {
  return { scope: "pane", terminalId, questionId };
}

export function referencedQuestion(reference: DecisionQuestionReference): DecisionQuestionTarget {
  return {
    scope: "reference",
    reference: {
      hostId: reference.hostId,
      projectId: reference.projectId,
      terminalId: reference.terminalId,
      questionId: reference.questionId,
    },
  };
}

/** The terminal that asked and the question's id, however it was opened. */
export function questionOf(target: DecisionQuestionTarget): {
  terminalId: string;
  questionId: string;
} {
  return target.scope === "pane"
    ? { terminalId: target.terminalId, questionId: target.questionId }
    : { terminalId: target.reference.terminalId, questionId: target.reference.questionId };
}

/** Names the question and the way it is read, so a late read never shows under another. */
export function targetKey(target: DecisionQuestionTarget): string {
  return target.scope === "pane"
    ? ["pane", target.terminalId, target.questionId].join("\u0000")
    : [
        "reference",
        target.reference.hostId,
        target.reference.projectId,
        target.reference.terminalId,
        target.reference.questionId,
      ].join("\u0000");
}

export function readTargetContent(
  target: DecisionQuestionTarget
): Promise<DecisionQuestionContentResult> {
  return target.scope === "pane"
    ? decisionsClient.getQuestionContent(target.terminalId, target.questionId)
    : decisionsClient.getQuestionContentByReference(target.reference);
}

export function readTargetImage(
  target: DecisionQuestionTarget,
  attachmentId: string,
  signal?: AbortSignal
): Promise<DecisionQuestionImageResult> {
  return target.scope === "pane"
    ? decisionsClient.getQuestionImage(target.terminalId, target.questionId, attachmentId, signal)
    : decisionsClient.getQuestionImageByReference(target.reference, attachmentId, signal);
}

/** The question's opening line, or null when it can't be read. Rejects when the read fails. */
export async function readTargetLine(target: DecisionQuestionTarget): Promise<string | null> {
  const { questionId } = questionOf(target);
  const result =
    target.scope === "pane"
      ? await decisionsClient.getQuestionSummaries(target.terminalId, [questionId])
      : await decisionsClient.getQuestionSummariesByReference([target.reference]);
  const summary: DecisionQuestionSummary | undefined =
    result.result === "read"
      ? result.summaries.find((candidate) => candidate.questionId === questionId)
      : undefined;
  return summary?.result === "read" ? summary.line : null;
}

export function cancelTarget(
  target: DecisionQuestionTarget
): Promise<DecisionQuestionCancelResult> {
  return target.scope === "pane"
    ? decisionsClient.cancelQuestion(target.terminalId, target.questionId)
    : decisionsClient.cancelQuestionByReference(target.reference);
}
