import { decisionsClient } from "@/clients/decisionsClient";
import {
  isInFlight,
  readAnswerRecord,
  useDecisionsAnswerStore,
  type AnswerHold,
  type AnswerPhase,
  type AnswerRecord,
} from "@/store/decisionsAnswerStore";
import { reviewKey, useDecisionsImageReviewStore } from "@/store/decisionsImageReviewStore";
import type {
  DecisionAnswerOutcome,
  DecisionQuestionAnswerResult,
} from "@shared/types/decisionsQuestion";
import { answerPayload, composeVerdict, isAnswerable } from "./decisionComposeModel";
import { questionOf, readTargetContent, type DecisionQuestionTarget } from "./decisionQuestionTarget";

/**
 * Sending the person's answer from the question view (#17102), and following
 * it until the relay has taken it. Outside React, so an answer already handed
 * to main settles its record even once the view has stepped away or closed.
 */

/** Taken by the relay, or committed here and being sent: what the person sees as sent, or sending. */
export function isCommitted(phase: AnswerPhase): boolean {
  if (phase.kind === "sending" || phase.kind === "checking" || phase.kind === "lost") return true;
  return (
    phase.kind === "settled" &&
    (phase.outcome.status === "queued" || phase.outcome.status === "sent")
  );
}

/** Whether Send may start a new answer: nothing in flight, and none taken. */
export function canStartAnswer(record: AnswerRecord): boolean {
  if (isInFlight(record)) return false;
  return record.submission === null || !isCommitted(record.submission.phase);
}

/** Changes the record, unless Decisions was cleared since `generation`. */
function change(
  key: string,
  generation: number,
  edit: (record: AnswerRecord) => AnswerRecord
): boolean {
  const store = useDecisionsAnswerStore.getState();
  if (store.generation !== generation) return false;
  store.update(key, edit);
  return true;
}

/** Moves the submission under `answerId` on, unless another one has replaced it. */
function setPhase(key: string, generation: number, answerId: string, phase: AnswerPhase): void {
  change(key, generation, (record) =>
    record.submission?.answerId === answerId
      ? { ...record, submission: { ...record.submission, phase } }
      : record
  );
}

function hold(key: string, generation: number, reason: AnswerHold): void {
  change(key, generation, (record) => ({ ...record, preparing: false, hold: reason }));
}

function phaseOf(result: DecisionQuestionAnswerResult): AnswerPhase {
  switch (result.result) {
    case "submitted":
      return { kind: "settled", outcome: result.outcome };
    case "refused":
      return { kind: "refused", reason: result.reason };
    default:
      return { kind: "refused", reason: result.result };
  }
}

function settled(outcome: DecisionAnswerOutcome): AnswerPhase {
  return { kind: "settled", outcome };
}

/** Hands the record's submission to main to sign, as it was built: same answer, same id. */
async function submit(key: string, generation: number): Promise<void> {
  const submission = readAnswerRecord(key).submission;
  if (submission === null) return;
  const { answerId } = submission;
  let result: DecisionQuestionAnswerResult;
  try {
    result = await decisionsClient.answerQuestion(submission.payload);
  } catch {
    // Main may have committed it before the reply was lost: read it by its id rather than guess.
    setPhase(key, generation, answerId, { kind: "checking" });
    await followAnswer(key);
    return;
  }
  setPhase(key, generation, answerId, phaseOf(result));
}

/**
 * Reads where the record's submission stands, by its id. One main never
 * committed is submitted again under the same id, once; after that, or when
 * the read itself fails, it waits for the person to retry.
 */
export async function followAnswer(key: string): Promise<void> {
  const generation = useDecisionsAnswerStore.getState().generation;
  const submission = readAnswerRecord(key).submission;
  if (submission === null) return;
  const { answerId } = submission;
  let read;
  try {
    read = await decisionsClient.getAnswerResult(answerId);
  } catch {
    setPhase(key, generation, answerId, { kind: "lost" });
    return;
  }
  switch (read.result) {
    case "read":
      setPhase(key, generation, answerId, settled(read.outcome));
      return;
    case "not-found":
      if (submission.resubmitted) {
        setPhase(key, generation, answerId, { kind: "lost" });
        return;
      }
      change(key, generation, (record) =>
        record.submission?.answerId === answerId
          ? {
              ...record,
              submission: { ...record.submission, resubmitted: true, phase: { kind: "sending" } },
            }
          : record
      );
      await submit(key, generation);
      return;
    case "off":
      setPhase(key, generation, answerId, { kind: "refused", reason: "off" });
      return;
    case "not-running":
      setPhase(key, generation, answerId, { kind: "lost" });
      return;
  }
}

/**
 * Sends the person's draft for `key`: reads the question again first, and
 * signs nothing unless it still takes an answer at the revision the person
 * read, with the choice, words and images the composer checked. The draft is
 * the store's at the moment of Send, never one passed in.
 */
export async function sendAnswer(
  key: string,
  target: DecisionQuestionTarget,
  now: () => number = Date.now
): Promise<void> {
  const generation = useDecisionsAnswerStore.getState().generation;
  const start = readAnswerRecord(key);
  const draft = start.draft;
  if (draft === null || !canStartAnswer(start)) return;
  change(key, generation, (record) => ({ ...record, preparing: true, hold: null }));

  let read;
  try {
    read = await readTargetContent(target);
  } catch {
    hold(key, generation, "failed");
    return;
  }
  if (read.result !== "read") {
    hold(key, generation, read.result === "not-running" ? "not-running" : "unreadable");
    return;
  }
  const question = read.question;
  const { terminalId, questionId } = questionOf(target);
  const reviewed =
    useDecisionsImageReviewStore.getState().byQuestion[reviewKey(terminalId, questionId)] ?? {};
  if (!isAnswerable(question, now())) {
    hold(key, generation, "closed");
    return;
  }
  const verdict = composeVerdict({ question, draft, reviewed, stale: false, closed: false });
  if (question.revision !== draft.revision || !verdict.canSend) {
    hold(key, generation, "changed");
    return;
  }
  const answerId = crypto.randomUUID();
  const payload = answerPayload(question, draft, reviewed, answerId);
  const placed = change(key, generation, (record) => ({
    ...record,
    preparing: false,
    submission: { answerId, payload, phase: { kind: "sending" }, resubmitted: false },
  }));
  if (placed) await submit(key, generation);
}
