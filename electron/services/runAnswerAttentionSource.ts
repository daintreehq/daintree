/**
 * How many received answers for each run need a person to decide what
 * happens to them, as Daintree Decisions last observed it. A leaf module, so
 * the fleet can decorate runs with it without importing Decisions: Decisions
 * loads only while it is on, and installs its counts here for that lifetime.
 * No counts means no run carries any, which is exactly Decisions off.
 */
let counts: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();

/** Answers needing attention for this run, or undefined when there are none. */
export function answerAttentionFor(runId: string): number | undefined {
  const count = counts.get(runId);
  return count !== undefined && count > 0 ? count : undefined;
}

/** Replaces every run's count (an empty map clears them), telling listeners only on a change. */
export function setAnswerAttention(next: ReadonlyMap<string, number>): void {
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

function sameCounts(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [runId, count] of a) if (b.get(runId) !== count) return false;
  return true;
}
