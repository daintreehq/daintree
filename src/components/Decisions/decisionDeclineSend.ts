import { decisionsClient } from "@/clients/decisionsClient";
import {
  answerKey,
  isDeclineInFlight,
  isInFlight,
  readAnswerRecord,
  useDecisionsAnswerStore,
  type DeclinePhase,
  type DeclineSubmission,
} from "@/store/decisionsAnswerStore";
import type {
  DecisionQuestionContent,
  DecisionQuestionDeclineResult,
} from "@shared/types/decisionsQuestion";
import { isDeclineCommitted, withDeadline } from "./decisionAnswerSend";
import { readTargetContent, type DecisionQuestionTarget } from "./decisionQuestionTarget";

/**
 * The person dismissing a question from this computer (#17239): a decline
 * signed by the owner computer, as a phone's Dismiss is, and followed by its
 * id until the relay has taken it or said why not. Outside React, so a
 * decline already handed to main settles its record once the view or the
 * dialog that asked has gone.
 */

/** The dismissal one send or one recovery is about: the store's generation then, and its id. */
interface Claim {
  generation: number;
  declineId: string;
}

function claimed(key: string, claim: Claim): DeclineSubmission | null {
  const store = useDecisionsAnswerStore.getState();
  if (store.generation !== claim.generation) return null;
  const decline = store.records[key]?.decline ?? null;
  return decline?.declineId === claim.declineId ? decline : null;
}

function updateClaimed(
  key: string,
  claim: Claim,
  edit: (decline: DeclineSubmission) => DeclineSubmission
): void {
  const store = useDecisionsAnswerStore.getState();
  if (store.generation !== claim.generation) return;
  store.update(key, (record) =>
    record.decline?.declineId === claim.declineId
      ? { ...record, decline: edit(record.decline) }
      : record
  );
}

function setPhase(key: string, claim: Claim, phase: DeclinePhase): void {
  updateClaimed(key, claim, (decline) => ({ ...decline, phase }));
}

/** Whether a new dismissal may start: no answer or dismissal from here under way or taken. */
export function canStartDecline(key: string): boolean {
  const record = readAnswerRecord(key);
  if (isInFlight(record) || isDeclineCommitted(record)) return false;
  const phase = record.submission?.phase;
  return !(
    phase?.kind === "settled" &&
    (phase.outcome.status === "sent" || phase.outcome.status === "queued")
  );
}

/**
 * Hands the claimed dismissal to main to sign, as it was built: same decline,
 * same id. `lost` when the reply never came back, or main's connection ended
 * under it, which can leave it committed: its standing is then read by id.
 */
async function submitOnce(key: string, claim: Claim): Promise<"replied" | "lost" | "gone"> {
  const decline = claimed(key, claim);
  if (decline === null) return "gone";
  let result: DecisionQuestionDeclineResult;
  try {
    result = await withDeadline(() => decisionsClient.declineQuestion(decline.payload));
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

/** Dismissals being followed now, by question and id, so two reads of one never race each other. */
const following = new Set<string>();

/**
 * Reads where the claimed dismissal stands, by its id. One main never
 * committed is sent again under the same id, once on its own and after that
 * on each Retry (`retry`): the library takes the same id as the same decline,
 * and the relay settles it against the revision it was signed for, so a
 * resend never declines anything twice or at a later revision.
 */
async function follow(key: string, claim: Claim, retry: boolean): Promise<void> {
  const lock = `${key}\u0000${claim.declineId}`;
  if (following.has(lock)) return;
  following.add(lock);
  try {
    if (claimed(key, claim)?.phase.kind === "lost") setPhase(key, claim, { kind: "checking" });
    let read;
    try {
      read = await withDeadline(() => decisionsClient.getDeclineResult(claim.declineId));
    } catch {
      setPhase(key, claim, { kind: "lost" });
      return;
    }
    const decline = claimed(key, claim);
    if (decline === null) return;
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
    if (decline.resubmitted && !retry) {
      setPhase(key, claim, { kind: "lost" });
      return;
    }
    updateClaimed(key, claim, (current) => ({
      ...current,
      resubmitted: true,
      phase: { kind: "sending" },
    }));
    if ((await submitOnce(key, claim)) === "lost") setPhase(key, claim, { kind: "lost" });
  } finally {
    following.delete(lock);
  }
}

/**
 * Reads where the question's dismissal from here stands now: a queued one's
 * progress, or, with `retry`, the person's Retry of one whose standing
 * couldn't be confirmed.
 */
export function followDecline(key: string, retry = false): Promise<void> {
  const store = useDecisionsAnswerStore.getState();
  const decline = store.records[key]?.decline ?? null;
  if (decline === null) return Promise.resolve();
  return follow(key, { generation: store.generation, declineId: decline.declineId }, retry);
}

/** Whether the question still waits for an answer, and so can be dismissed. */
export function isWaitingQuestion(question: DecisionQuestionContent): boolean {
  return question.status === "queued" || question.status === "open";
}

/**
 * What came of a Dismiss before or after anything was signed:
 * - `failed`, the question couldn't be read again first (`not-running`: no
 *   relay connection to read it with);
 * - `gone`, the read found it no longer kept, or not waiting any more;
 * - `changed`, it moved on from the revision the person read;
 * - `busy`, an answer or another dismissal from here is under way;
 * - `submitted`, handed to main, with where it stands now.
 */
export type DismissAttempt =
  | { kind: "failed"; reason: "not-running" | "unreadable" | "failed" | "off" }
  | { kind: "gone" }
  | { kind: "changed" }
  | { kind: "busy" }
  | { kind: "submitted"; key: string; phase: DeclinePhase };

/**
 * Dismisses the question `target` names: reads it again first, and signs
 * nothing unless it still waits, at `revision` when the person read one
 * (the view), or at the revision it is open at now (a row naming it only by
 * alias). A dismissal of it already under way is read again instead, under
 * its own id, so a second Dismiss never signs a second decline.
 */
export async function dismissQuestion(
  target: DecisionQuestionTarget,
  revision: number | null
): Promise<DismissAttempt> {
  const generation = useDecisionsAnswerStore.getState().generation;
  let read;
  try {
    read = await withDeadline(() => readTargetContent(target));
  } catch {
    return { kind: "failed", reason: "failed" };
  }
  switch (read.result) {
    case "read":
      break;
    case "not-found":
      return { kind: "gone" };
    case "off":
    case "not-running":
    case "unreadable":
      return { kind: "failed", reason: read.result };
  }
  const question = read.question;
  const key = answerKey(question.reference);
  const record = readAnswerRecord(key);
  if (isDeclineInFlight(record)) {
    await followDecline(key, true);
    return settledAttempt(key);
  }
  // Taken already, and the question hasn't closed here yet.
  if (isDeclineCommitted(record)) return settledAttempt(key);
  if (!isWaitingQuestion(question)) return { kind: "gone" };
  if (revision !== null && question.revision !== revision) return { kind: "changed" };
  if (!canStartDecline(key)) return { kind: "busy" };
  const store = useDecisionsAnswerStore.getState();
  if (store.generation !== generation) return { kind: "failed", reason: "off" };
  const claim: Claim = { generation, declineId: crypto.randomUUID() };
  store.update(key, (current) => ({
    ...current,
    decline: {
      declineId: claim.declineId,
      payload: {
        reference: question.reference,
        declineId: claim.declineId,
        expectedRevision: question.revision,
      },
      phase: { kind: "sending" },
      resubmitted: false,
    },
  }));
  // Main may have committed it before the reply was lost: read it by its id rather than guess.
  if ((await submitOnce(key, claim)) === "lost") {
    setPhase(key, claim, { kind: "checking" });
    await follow(key, claim, false);
  }
  return settledAttempt(key);
}

function settledAttempt(key: string): DismissAttempt {
  const phase = readAnswerRecord(key).decline?.phase;
  // Cleared while it was being sent: Decisions went off.
  if (phase === undefined) return { kind: "failed", reason: "off" };
  return { kind: "submitted", key, phase };
}
