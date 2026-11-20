import { decisionsClient } from "@/clients/decisionsClient";
import {
  isDeclineInFlight,
  isInFlight,
  readAnswerRecord,
  useDecisionsAnswerStore,
  type AnswerHold,
  type AnswerPhase,
  type AnswerRecord,
  type AnswerSubmission,
} from "@/store/decisionsAnswerStore";
import { reviewKey, useDecisionsImageReviewStore } from "@/store/decisionsImageReviewStore";
import type { DecisionQuestionAnswerResult } from "@shared/types/decisionsQuestion";
import {
  answerPayload,
  composeVerdict,
  isAnswerable,
  type UnshownImages,
} from "./decisionComposeModel";
import {
  questionOf,
  readTargetContent,
  type DecisionQuestionTarget,
} from "./decisionQuestionTarget";

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

/** Whether Send may start a new answer: nothing in flight, none taken, and no dismissal from here. */
export function canStartAnswer(record: AnswerRecord): boolean {
  if (isInFlight(record) || isDeclineCommitted(record)) return false;
  return record.submission === null || !isCommitted(record.submission.phase);
}

/** A dismissal from here that is under way or was taken: the question isn't answered from here meanwhile. */
export function isDeclineCommitted(record: AnswerRecord): boolean {
  if (isDeclineInFlight(record)) return true;
  const phase = record.decline?.phase;
  return phase?.kind === "settled" && phase.outcome.status === "declined";
}

/** The answer one send or one recovery is about: the store's generation then, and its id. */
interface Claim {
  generation: number;
  answerId: string;
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

/** The claimed submission, while nothing has cleared or replaced it. */
function claimed(key: string, claim: Claim): AnswerSubmission | null {
  const store = useDecisionsAnswerStore.getState();
  if (store.generation !== claim.generation) return null;
  const submission = store.records[key]?.submission ?? null;
  return submission?.answerId === claim.answerId ? submission : null;
}

function updateClaimed(
  key: string,
  claim: Claim,
  edit: (submission: AnswerSubmission, record: AnswerRecord) => AnswerRecord
): void {
  change(key, claim.generation, (record) =>
    record.submission?.answerId === claim.answerId ? edit(record.submission, record) : record
  );
}

function setPhase(key: string, claim: Claim, phase: AnswerPhase): void {
  updateClaimed(key, claim, (submission, record) => ({
    ...record,
    submission: { ...submission, phase },
  }));
}

/** Lets go of an answer nothing was committed for, saying why it wasn't sent; the draft stays. */
function drop(key: string, claim: Claim, reason: AnswerHold): void {
  updateClaimed(key, claim, (_submission, record) => ({
    ...record,
    submission: null,
    hold: reason,
  }));
}

function hold(key: string, generation: number, reason: AnswerHold): void {
  change(key, generation, (record) => ({ ...record, preparing: false, hold: reason }));
}

/**
 * How long one call to main may take before its answer is treated as lost:
 * past the relay's own send timeout, after which main queues it instead.
 */
const MAIN_DEADLINE_MS = 30_000;

class DeadlineError extends Error {
  constructor() {
    super("Decisions didn't reply in time");
    this.name = "DeadlineError";
  }
}

/** `call`, or a rejection once the deadline passes; a reply after that is ignored. */
export function withDeadline<T>(call: () => Promise<T>): Promise<T> {
  // Called first, so one that throws at once never leaves a deadline armed.
  const pending = call();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError()), MAIN_DEADLINE_MS);
  });
  return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Hands the claimed submission to main to sign, as it was built: same answer,
 * same id. Resolves `lost` when the reply never came back, or when main's
 * connection ended under it, which can leave it committed: either way its
 * standing has to be read by its id.
 */
async function submitOnce(key: string, claim: Claim): Promise<"replied" | "lost" | "gone"> {
  const submission = claimed(key, claim);
  if (submission === null) return "gone";
  let result: DecisionQuestionAnswerResult;
  try {
    result = await withDeadline(() => decisionsClient.answerQuestion(submission.payload));
  } catch {
    return "lost";
  }
  switch (result.result) {
    case "submitted":
      setPhase(key, claim, { kind: "settled", outcome: result.outcome });
      return "replied";
    case "refused":
      setPhase(key, claim, { kind: "refused", reason: result.reason });
      return "replied";
    case "off":
      setPhase(key, claim, { kind: "refused", reason: "off" });
      return "replied";
    case "not-running":
      return "lost";
  }
}

/** Answers being followed now, by question and id, so two reads of one never race each other. */
const following = new Set<string>();

/**
 * Reads where the claimed submission stands, by its id. One main hasn't
 * committed is sent again under the same id, and only while the question
 * still takes it at the revision it was signed against: once on its own, and
 * after that on each Retry (`retry`). Its id is never given up while a send
 * of it could still be under way, so it can never be answered twice: main
 * returns the stored outcome for the same answer under the same id.
 */
async function follow(key: string, claim: Claim, retry: boolean): Promise<void> {
  const lock = `${key}\u0000${claim.answerId}`;
  if (following.has(lock)) return;
  following.add(lock);
  try {
    // Retry goes as it starts, so it can't be pressed twice.
    if (claimed(key, claim)?.phase.kind === "lost") setPhase(key, claim, { kind: "checking" });
    let read;
    try {
      read = await withDeadline(() => decisionsClient.getAnswerResult(claim.answerId));
    } catch {
      setPhase(key, claim, { kind: "lost" });
      return;
    }
    const submission = claimed(key, claim);
    if (submission === null) return;
    switch (read.result) {
      case "read":
        setPhase(key, claim, { kind: "settled", outcome: read.outcome });
        return;
      case "off":
        setPhase(key, claim, { kind: "refused", reason: "off" });
        return;
      case "not-running":
        setPhase(key, claim, { kind: "lost" });
        return;
      case "not-found":
        break;
    }
    if (submission.resubmitted && !retry) {
      setPhase(key, claim, { kind: "lost" });
      return;
    }
    let fresh;
    try {
      fresh = await withDeadline(() => readTargetContent(submission.target));
    } catch {
      fresh = null;
    }
    if (claimed(key, claim) === null) return;
    // A question that is gone lets it go, since nothing can answer it now; one
    // that can't be read just now leaves Retry, as a send of it may be under way.
    if (fresh?.result === "not-found") {
      drop(key, claim, "closed");
      return;
    }
    if (fresh === null || fresh.result !== "read") {
      setPhase(key, claim, { kind: "lost" });
      return;
    }
    // A send of it got there after all: the relay took it.
    if (
      fresh.question.thread.some(
        (entry) => entry.type === "answer" && entry.entryId === claim.answerId
      )
    ) {
      setPhase(key, claim, { kind: "settled", outcome: { status: "sent" } });
      return;
    }
    if (!isAnswerable(fresh.question, Date.now())) {
      drop(key, claim, "closed");
      return;
    }
    if (fresh.question.revision !== submission.payload.expectedRevision) {
      drop(key, claim, "changed");
      return;
    }
    updateClaimed(key, claim, (current, record) => ({
      ...record,
      submission: { ...current, resubmitted: true, phase: { kind: "sending" } },
    }));
    if ((await submitOnce(key, claim)) === "lost") setPhase(key, claim, { kind: "lost" });
  } finally {
    following.delete(lock);
  }
}

/**
 * Reads where the record's answer stands now: a queued one's progress, or,
 * with `retry`, the person's Retry of one whose standing couldn't be confirmed.
 */
export function followAnswer(key: string, retry = false): Promise<void> {
  const store = useDecisionsAnswerStore.getState();
  const submission = store.records[key]?.submission ?? null;
  if (submission === null) return Promise.resolve();
  return follow(key, { generation: store.generation, answerId: submission.answerId }, retry);
}

/**
 * Sends the person's draft for `key`: reads the question again first, and
 * signs nothing unless it still takes an answer at the revision the person
 * read, with the choice, words and images the composer checked. The draft is
 * the store's at the moment of Send, never one passed in; `unshown` is the
 * view's, the images it couldn't show as Send was pressed, and excuses only
 * the digests the question still lists them under.
 */
export async function sendAnswer(
  key: string,
  target: DecisionQuestionTarget,
  unshown: UnshownImages,
  now: () => number = Date.now
): Promise<void> {
  const generation = useDecisionsAnswerStore.getState().generation;
  const start = readAnswerRecord(key);
  const draft = start.draft;
  if (draft === null || !canStartAnswer(start)) return;
  change(key, generation, (record) => ({ ...record, preparing: true, hold: null }));

  let read;
  try {
    read = await withDeadline(() => readTargetContent(target));
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
  const verdict = composeVerdict({
    question,
    draft,
    reviewed,
    unshown,
    stale: false,
    closed: false,
  });
  if (question.revision !== draft.revision || !verdict.canSend) {
    hold(key, generation, "changed");
    return;
  }
  const claim: Claim = { generation, answerId: crypto.randomUUID() };
  const payload = answerPayload(question, draft, reviewed, claim.answerId);
  const placed = change(key, generation, (record) => ({
    ...record,
    preparing: false,
    submission: {
      answerId: claim.answerId,
      payload,
      target,
      phase: { kind: "sending" },
      resubmitted: false,
    },
  }));
  if (!placed) return;
  // Main may have committed it before the reply was lost: read it by its id rather than guess.
  if ((await submitOnce(key, claim)) === "lost") {
    setPhase(key, claim, { kind: "checking" });
    await follow(key, claim, false);
  }
}
