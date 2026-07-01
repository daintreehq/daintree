/**
 * Rolling window for action-usage frequency. The command palette ranks actions
 * by how many times each was used inside this window, so ranking "forgets"
 * activity older than a week instead of accumulating a frecency score forever.
 */
export const USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-action cap on retained use timestamps. The ranking bonus saturates (tanh)
 * well below this, so keeping more would only bloat persistence. When exceeded,
 * the most-recent uses are kept.
 */
export const MAX_USES_PER_ENTRY = 100;

/**
 * Normalize a list of use timestamps to the current rolling window: drop any
 * that are non-finite, in the future, or older than {@link USAGE_WINDOW_MS};
 * sort ascending; and retain at most {@link MAX_USES_PER_ENTRY} most-recent
 * entries. Returns a fresh array — the input is never mutated.
 */
export function pruneUses(uses: readonly number[], nowMs: number): number[] {
  const cutoff = nowMs - USAGE_WINDOW_MS;
  const kept = uses
    .filter((t) => typeof t === "number" && Number.isFinite(t) && t > cutoff && t <= nowMs)
    .sort((a, b) => a - b);
  return kept.length > MAX_USES_PER_ENTRY ? kept.slice(kept.length - MAX_USES_PER_ENTRY) : kept;
}
