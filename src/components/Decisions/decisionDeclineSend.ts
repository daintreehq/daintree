import { decisionsClient } from "@/clients/decisionsClient";
import {
  answerKey,
  isDeclineInFlight,
  isInFlight,
  readAnswerRecord,
  useDecisionsAnswerStore,
  type AnswerRecord,
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
 * dialog that asked has gone, and a queued one is read again on its own
 * wherever it was asked from.
 */

/** While a dismissal is queued, how long after one read of its standing the next starts. */
export const QUEUED_DECLINE_READ_MS = 5_000;

/** The longest wait between reads while main can't say where a dismissal stands. */
const LOST_DECLINE_READ_MAX_MS = 60_000;

/** The dismissal one send or one recovery is about: the store's generation then, and its id. */
interface Claim {
  generation: number;
  declineId: string;
}

function lockOf(key: string, claim: Claim): string {
  return `${key}\u0000${claim.declineId}`;
}

function claimed(key: string, claim: Claim): DeclineSubmission | null {
  const store = useDecisionsAnswerStore.getState();
  if (store.generation !== claim.generation) return null;
  const decline = store.records[key]?.decline ?? null;
  return decline?.declineId === claim.declineId ? decline : null;
}

/** The claim on the dismissal the record holds now, in the store's current generation. */
function claimOf(key: string): Claim | null {
  const store = useDecisionsAnswerStore.getState();
  const decline = store.records[key]?.decline ?? null;
  return decline === null ? null : { generation: store.generation, declineId: decline.declineId };
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

function isQueued(phase: DeclinePhase): boolean {
  return phase.kind === "settled" && phase.outcome.status === "queued";
}

/**
 * Waiting on main to say where it stands: queued there, its standing couldn't
 * be read, or a Retry is reading or sending it now, whose read a follower joins.
 */
function isUnsettled(phase: DeclinePhase): boolean {
  return (
    isQueued(phase) ||
    phase.kind === "lost" ||
    phase.kind === "checking" ||
    phase.kind === "sending"
  );
}

function setPhase(key: string, claim: Claim, phase: DeclinePhase): void {
  updateClaimed(key, claim, (decline) => ({ ...decline, phase }));
  if (isQueued(phase)) watchQueued(key, claim);
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

/**
 * Each dismissal's send or recovery under way, by question and id: a second
 * one waits for it rather than racing it, so phases land in the order main
 * answered and a Retry never resends over a send still out.
 */
const running = new Map<string, Promise<void>>();

function exclusive(key: string, claim: Claim, body: () => Promise<void>): Promise<void> {
  const lock = lockOf(key, claim);
  const current = running.get(lock);
  if (current !== undefined) return current;
  const run = body().finally(() => running.delete(lock));
  running.set(lock, run);
  return run;
}

/**
 * Reads where the claimed dismissal stands, by its id. One main never
 * committed is sent again under the same id, once on its own and after that
 * on each Retry (`retry`): the library takes the same id as the same decline,
 * and the relay settles it against the revision it was signed for, so a
 * resend never declines anything twice or at a later revision.
 */
async function followOnce(key: string, claim: Claim, retry: boolean): Promise<void> {
  const start = claimed(key, claim);
  // Cleared, or another dismissal took its place: nothing of this one is read again.
  if (start === null) return;
  if (start.phase.kind === "lost") setPhase(key, claim, { kind: "checking" });
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
}

async function follow(key: string, claim: Claim, retry: boolean): Promise<void> {
  const joined = running.has(lockOf(key, claim));
  await exclusive(key, claim, () => followOnce(key, claim, retry));
  // A Retry that joined a read already under way, which may not resend, still gets its own.
  if (joined && retry && claimed(key, claim)?.phase.kind === "lost") {
    await exclusive(key, claim, () => followOnce(key, claim, true));
  }
}

/** Dismissals main has queued, read again on a timer: its next read, and the wait before it. */
const watching = new Map<
  string,
  { timer: ReturnType<typeof setTimeout> | undefined; wait: number }
>();

/**
 * Reads a dismissal main has queued again every few seconds until it settles,
 * the record moves on to another dismissal, or Decisions is cleared, so the
 * chip and the view both learn when the relay takes it or why not, however
 * long the relay stays out of reach. A read main can't answer leaves it
 * `lost`, and it's read less often each time, up to a minute: main holds it,
 * under its id, so reading it again never declines anything twice. One main
 * never acknowledged isn't followed: Retry reads it.
 */
function watchQueued(key: string, claim: Claim): void {
  const lock = lockOf(key, claim);
  const existing = watching.get(lock);
  if (existing !== undefined) {
    // Queued again after reads main couldn't answer: back to the queued pace.
    if (existing.wait > QUEUED_DECLINE_READ_MS && existing.timer !== undefined) {
      clearTimeout(existing.timer);
      existing.wait = QUEUED_DECLINE_READ_MS;
      scheduleRead(key, claim);
    }
    return;
  }
  watching.set(lock, { timer: undefined, wait: QUEUED_DECLINE_READ_MS });
  scheduleRead(key, claim);
}

function scheduleRead(key: string, claim: Claim): void {
  const lock = lockOf(key, claim);
  const entry = watching.get(lock);
  if (entry === undefined) return;
  const stillUnsettled = () => {
    const decline = claimed(key, claim);
    if (decline !== null && isUnsettled(decline.phase)) return decline;
    watching.delete(lock);
    return null;
  };
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    // Settled meanwhile by a Retry or another surface: nothing more to read.
    if (stillUnsettled() === null) return;
    void follow(key, claim, false).finally(() => {
      const decline = stillUnsettled();
      // Gone, or already scheduled again by its return to queued.
      if (decline === null || entry.timer !== undefined) return;
      entry.wait =
        decline.phase.kind === "lost"
          ? Math.min(entry.wait * 2, LOST_DECLINE_READ_MAX_MS)
          : QUEUED_DECLINE_READ_MS;
      scheduleRead(key, claim);
    });
  }, entry.wait);
}

/**
 * Reads where the question's dismissal from here stands now, or, with
 * `retry`, the person's Retry of one whose standing couldn't be confirmed.
 */
export function followDecline(key: string, retry = false): Promise<void> {
  const claim = claimOf(key);
  return claim === null ? Promise.resolve() : follow(key, claim, retry);
}

/** Whether the question still waits for an answer, and so can be dismissed. */
export function isWaitingQuestion(question: DecisionQuestionContent): boolean {
  return question.status === "queued" || question.status === "open";
}

/**
 * The questions of `terminalId` with a dismissal from here under way or
 * taken, joined so a selector re-renders only when the set changes.
 */
export function dismissingQuestionIds(
  records: Readonly<Record<string, AnswerRecord>>,
  terminalId: string
): string {
  const ids: string[] = [];
  for (const record of Object.values(records)) {
    const reference = record.decline?.payload.reference;
    if (reference?.terminalId === terminalId && isDeclineCommitted(record)) {
      ids.push(reference.questionId);
    }
  }
  return ids.sort().join("\u0000");
}

/**
 * What came of a Dismiss before or after anything was signed:
 * - `failed`, the question couldn't be read again first (`not-running`: no
 *   relay connection to read it with), or Decisions was cleared (`off`);
 * - `gone`, the read found it no longer kept, or not waiting any more;
 * - `changed`, it moved on from the revision the person read;
 * - `busy`, an answer from here is under way;
 * - `submitted`, handed to main, with where it stands now.
 */
export type DismissAttempt =
  | {
      kind: "failed";
      reason: "not-running" | "unreadable" | "failed" | "off" | "host-not-connected";
    }
  | { kind: "gone" }
  | { kind: "changed" }
  | { kind: "busy" }
  | { kind: "submitted"; key: string; phase: DeclinePhase };

function settledAttempt(key: string, claim: Claim): DismissAttempt {
  if (useDecisionsAnswerStore.getState().generation !== claim.generation) {
    return { kind: "failed", reason: "off" };
  }
  // Another dismissal of the question took over meanwhile: say where that one stands.
  const decline = readAnswerRecord(key).decline;
  if (decline === null) return { kind: "failed", reason: "off" };
  return { kind: "submitted", key, phase: decline.phase };
}

/** Reads the in-flight dismissal of `key` again by its id, as a Retry. */
async function recover(key: string): Promise<DismissAttempt> {
  const claim = claimOf(key);
  if (claim === null) return { kind: "failed", reason: "off" };
  await follow(key, claim, true);
  return settledAttempt(key, claim);
}

/**
 * Dismisses the question `target` names: reads it again first, and signs
 * nothing unless it still waits, at `revision` when the person read one
 * (the view), or at the revision it is open at now (a row naming it only by
 * alias). A dismissal of it already under way is read again instead, by its
 * id: first from `known`, the record the last try was kept under, without
 * reading the question again, since the computer that asked may be out of
 * reach while this one holds the answer. A second Dismiss never signs a
 * second decline.
 */
export async function dismissQuestion(
  target: DecisionQuestionTarget,
  revision: number | null,
  known: string | null = null
): Promise<DismissAttempt> {
  if (known !== null && isDeclineInFlight(readAnswerRecord(known))) return recover(known);
  const generation = useDecisionsAnswerStore.getState().generation;
  let read;
  try {
    read = await withDeadline(() => readTargetContent(target));
  } catch {
    return { kind: "failed", reason: "failed" };
  }
  if (useDecisionsAnswerStore.getState().generation !== generation) {
    return { kind: "failed", reason: "off" };
  }
  switch (read.result) {
    case "read":
      break;
    case "not-found":
      return { kind: "gone" };
    case "off":
    case "not-running":
    case "unreadable":
    case "host-not-connected":
      return { kind: "failed", reason: read.result };
  }
  const question = read.question;
  const key = answerKey(question.reference);
  const record = readAnswerRecord(key);
  if (isDeclineInFlight(record)) return recover(key);
  // Taken already, and the question hasn't closed here yet.
  if (isDeclineCommitted(record)) return settledAttempt(key, claimOf(key)!);
  if (!isWaitingQuestion(question)) return { kind: "gone" };
  if (revision !== null && question.revision !== revision) return { kind: "changed" };
  if (!canStartDecline(key)) return { kind: "busy" };
  const claim: Claim = { generation, declineId: crypto.randomUUID() };
  useDecisionsAnswerStore.getState().update(key, (current) => ({
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
  await exclusive(key, claim, async () => {
    // Main may have committed it before the reply was lost: read it by its id rather than guess.
    if ((await submitOnce(key, claim)) === "lost") {
      setPhase(key, claim, { kind: "checking" });
      await followOnce(key, claim, false);
    }
  });
  return settledAttempt(key, claim);
}
