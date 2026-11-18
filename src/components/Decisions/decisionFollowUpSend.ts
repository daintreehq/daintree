import { decisionsClient } from "@/clients/decisionsClient";
import { answerKey } from "@/store/decisionsAnswerStore";
import {
  isFollowUpInFlight,
  readFollowUpRecord,
  useDecisionsFollowUpStore,
  type FollowUpHold,
  type FollowUpPhase,
  type FollowUpRecord,
  type FollowUpSubmission,
} from "@/store/decisionsFollowUpStore";
import type { DecisionQuestionFollowUpResult } from "@shared/types/decisionsQuestion";
import { withDeadline } from "./decisionAnswerSend";
import { followUpVerdict, takesFollowUp } from "./decisionFollowUpModel";
import { readTargetContent, type DecisionQuestionTarget } from "./decisionQuestionTarget";

/**
 * Sending the person's follow-up from the question view (#17238), and
 * following it until the relay has taken it, as an answer is sent
 * (`decisionAnswerSend`). Outside React, so a message already handed to main
 * settles its record even once the view has stepped away or closed.
 */

/** Taken by the relay, or committed here and being sent. */
export function isFollowUpCommitted(phase: FollowUpPhase): boolean {
  if (phase.kind === "sending" || phase.kind === "checking" || phase.kind === "lost") return true;
  return (
    phase.kind === "settled" &&
    (phase.outcome.status === "queued" || phase.outcome.status === "sent")
  );
}

/** Committed here, but not yet known to be taken by the relay. */
export function awaitsConfirmation(phase: FollowUpPhase): boolean {
  return phase.kind === "lost" || (phase.kind === "settled" && phase.outcome.status === "queued");
}

/** Whether Send may start a new follow-up: words to send, and nothing in flight. */
export function canStartFollowUp(record: FollowUpRecord): boolean {
  return !isFollowUpInFlight(record) && followUpVerdict(record.draft).canSend;
}

/** The follow-up one send or one recovery is about: the store's generation then, and its id. */
interface Claim {
  generation: number;
  messageId: string;
}

/** Changes the record, unless Decisions was cleared since `generation`. */
function change(
  key: string,
  generation: number,
  edit: (record: FollowUpRecord) => FollowUpRecord
): boolean {
  const store = useDecisionsFollowUpStore.getState();
  if (store.generation !== generation) return false;
  store.update(key, edit);
  return true;
}

/** The claimed submission, while nothing has cleared or replaced it. */
function claimed(key: string, claim: Claim): FollowUpSubmission | null {
  const store = useDecisionsFollowUpStore.getState();
  if (store.generation !== claim.generation) return null;
  const submission = store.records[key]?.submission ?? null;
  return submission?.messageId === claim.messageId ? submission : null;
}

/**
 * Edits the claimed submission. Taken stays taken: once the relay took it, no
 * read that lands later (an outbox still saying queued, a recovery that
 * found nothing by its id) moves, drops or sends it again.
 */
function updateClaimed(
  key: string,
  claim: Claim,
  edit: (submission: FollowUpSubmission, record: FollowUpRecord) => FollowUpRecord
): void {
  change(key, claim.generation, (record) =>
    record.submission?.messageId === claim.messageId && !isSent(record.submission.phase)
      ? edit(record.submission, record)
      : record
  );
}

/**
 * Moves the claimed follow-up on. Once the relay has taken it its words
 * leave the draft, unless the person has written something else since; a
 * queued one keeps them, as the relay may still turn it away.
 */
function setPhase(key: string, claim: Claim, phase: FollowUpPhase): void {
  const taken = phase.kind === "settled" && phase.outcome.status === "sent";
  updateClaimed(key, claim, (submission, record) => ({
    ...record,
    draft: taken && record.draft === submission.payload.text ? "" : record.draft,
    submission: { ...submission, phase },
  }));
}

function isSent(phase: FollowUpPhase): boolean {
  return phase.kind === "settled" && phase.outcome.status === "sent";
}

/** Lets go of a follow-up nothing was committed for, saying why it wasn't sent; the draft stays. */
function drop(key: string, claim: Claim, reason: FollowUpHold): void {
  updateClaimed(key, claim, (_submission, record) => ({
    ...record,
    submission: null,
    hold: reason,
  }));
}

function hold(key: string, generation: number, reason: FollowUpHold): void {
  change(key, generation, (record) => ({ ...record, preparing: false, hold: reason }));
}

/**
 * Hands the claimed submission to main to sign, as it was built: same words,
 * same id. Resolves `lost` when the reply never came back, or when main's
 * connection ended under it, which can leave it committed: either way its
 * standing has to be read by its id.
 */
async function submitOnce(key: string, claim: Claim): Promise<"replied" | "lost" | "gone"> {
  const submission = claimed(key, claim);
  if (submission === null) return "gone";
  let result: DecisionQuestionFollowUpResult;
  try {
    result = await withDeadline(() => decisionsClient.sendFollowUp(submission.payload));
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

/** Follow-ups being followed now, by question and id, so two reads of one never race each other. */
const following = new Set<string>();

/**
 * Reads where the claimed submission stands, by its id. One main hasn't
 * committed is sent again under the same id, and only while the question
 * still takes a follow-up: once on its own, and after that on each Retry
 * (`retry`). Its id is never given up while a send of it could still be
 * under way, so it can never be sent twice: main returns the stored outcome
 * for the same message under the same id.
 */
async function follow(key: string, claim: Claim, retry: boolean): Promise<void> {
  const lock = `${key}\u0000${claim.messageId}`;
  if (following.has(lock)) return;
  following.add(lock);
  try {
    // Retry goes as it starts, so it can't be pressed twice.
    if (claimed(key, claim)?.phase.kind === "lost") setPhase(key, claim, { kind: "checking" });
    let read;
    try {
      read = await withDeadline(() => decisionsClient.getFollowUpResult(claim.messageId));
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
    // A question that is gone lets it go, since nothing can take it now; one
    // that can't be read just now leaves Retry, as a send of it may be under way.
    if (fresh?.result === "not-found") {
      drop(key, claim, "closed");
      return;
    }
    if (fresh === null || fresh.result !== "read" || answerKey(fresh.question.reference) !== key) {
      setPhase(key, claim, { kind: "lost" });
      return;
    }
    // A send of it got there after all: the relay took it.
    if (
      fresh.question.thread.some(
        (entry) => entry.type === "message" && entry.messageId === claim.messageId
      )
    ) {
      setPhase(key, claim, { kind: "settled", outcome: { status: "sent" } });
      return;
    }
    if (!takesFollowUp(fresh.question, Date.now())) {
      drop(key, claim, "closed");
      return;
    }
    updateClaimed(key, claim, (current, record) => ({
      ...record,
      submission: { ...current, resubmitted: true, phase: { kind: "sending" } },
    }));
    // Taken meanwhile (the thread showed it): nothing to send again.
    if (claimed(key, claim)?.phase.kind !== "sending") return;
    if ((await submitOnce(key, claim)) === "lost") setPhase(key, claim, { kind: "lost" });
  } finally {
    following.delete(lock);
  }
}

/**
 * The question's thread holds a follow-up this view still has as unconfirmed
 * or queued (a receipt the owner computer missed): the relay took it, so it
 * is settled as sent.
 */
export function confirmFollowUpInThread(key: string, messageId: string): void {
  const store = useDecisionsFollowUpStore.getState();
  const submission = store.records[key]?.submission ?? null;
  if (submission?.messageId !== messageId || !awaitsConfirmation(submission.phase)) return;
  setPhase(
    key,
    { generation: store.generation, messageId },
    {
      kind: "settled",
      outcome: { status: "sent" },
    }
  );
}

/**
 * Reads where the record's follow-up stands now: a queued one's progress, or,
 * with `retry`, the person's Retry of one whose standing couldn't be confirmed.
 */
export function followFollowUp(key: string, retry = false): Promise<void> {
  const store = useDecisionsFollowUpStore.getState();
  const submission = store.records[key]?.submission ?? null;
  if (submission === null) return Promise.resolve();
  return follow(key, { generation: store.generation, messageId: submission.messageId }, retry);
}

/**
 * Sends the person's draft for `key`: reads the question again first, and
 * signs nothing unless it still takes a follow-up. The words are the store's
 * at the moment of Send, never ones passed in.
 */
export async function sendFollowUp(
  key: string,
  target: DecisionQuestionTarget,
  now: () => number = Date.now
): Promise<void> {
  const generation = useDecisionsFollowUpStore.getState().generation;
  const start = readFollowUpRecord(key);
  if (!canStartFollowUp(start)) return;
  const text = start.draft;
  // The last attempt's failure goes as this one starts; one the relay took stays shown until this one moves.
  change(key, generation, (record) => ({
    ...record,
    preparing: true,
    hold: null,
    submission:
      record.submission !== null && isFollowUpCommitted(record.submission.phase)
        ? record.submission
        : null,
  }));

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
  // Only ever the question the person was looking at, whatever the machine serving the read says now.
  if (answerKey(read.question.reference) !== key) {
    hold(key, generation, "unreadable");
    return;
  }
  if (!takesFollowUp(read.question, now())) {
    hold(key, generation, "closed");
    return;
  }
  const claim: Claim = { generation, messageId: crypto.randomUUID() };
  const placed = change(key, generation, (record) => ({
    ...record,
    preparing: false,
    submission: {
      messageId: claim.messageId,
      payload: { reference: read.question.reference, messageId: claim.messageId, text },
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
