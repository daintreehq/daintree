import type { FleetRunRow } from "../../shared/types/ipc/fleet.js";

/**
 * What Daintree Decisions last observed of each run: received answers whose
 * delivery needs a person to decide what happens to them, and questions open
 * in Needs you that the person hasn't cleared on this computer. A leaf
 * module, so the fleet can decorate runs with it without importing Decisions:
 * Decisions loads only while it is on, and installs its counts here for that
 * lifetime. No counts means no run carries any, which is exactly Decisions off.
 */
export interface RunDecisionAttention {
  answers: number;
  questions: number;
}

/** Both counts as a fleet row carries them, each present only above zero. */
export type RunDecisionAttentionFields = Pick<FleetRunRow, "answerAttention" | "questionAttention">;

let counts: ReadonlyMap<string, RunDecisionAttention> = new Map();
const listeners = new Set<() => void>();

/** Answers needing attention for this run, or undefined when there are none. */
export function answerAttentionFor(runId: string): number | undefined {
  const count = counts.get(runId)?.answers;
  return count !== undefined && count > 0 ? count : undefined;
}

/** Open, uncleared questions for this run, or undefined when there are none. */
export function questionAttentionFor(runId: string): number | undefined {
  const count = counts.get(runId)?.questions;
  return count !== undefined && count > 0 ? count : undefined;
}

/** This run's counts as row fields; an empty object when it has none. */
export function decisionAttentionFor(runId: string): RunDecisionAttentionFields {
  const answerAttention = answerAttentionFor(runId);
  const questionAttention = questionAttentionFor(runId);
  return {
    ...(answerAttention !== undefined ? { answerAttention } : {}),
    ...(questionAttention !== undefined ? { questionAttention } : {}),
  };
}

/** Replaces every run's counts (an empty map clears them), telling listeners only on a change. */
export function setDecisionAttention(next: ReadonlyMap<string, RunDecisionAttention>): void {
  if (sameCounts(counts, next)) return;
  counts = new Map(next);
  for (const listener of [...listeners]) listener();
}

/** Be told each time the counts change. Returns the unsubscribe. */
export function onAnswerAttentionChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function sameCounts(
  a: ReadonlyMap<string, RunDecisionAttention>,
  b: ReadonlyMap<string, RunDecisionAttention>
): boolean {
  if (a.size !== b.size) return false;
  for (const [runId, count] of a) {
    const other = b.get(runId);
    if (other?.answers !== count.answers || other.questions !== count.questions) return false;
  }
  return true;
}
