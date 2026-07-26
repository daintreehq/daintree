// Project-switcher ranking. One exponentially decayed scalar per project: the
// (score, lastAccessedAt) pair is the exact sufficient statistic for the whole
// decayed access history, so ranking only ever needs these two fields plus a
// consistent `now`. Ordering between untouched projects is invariant as time
// passes — every effective score decays by the same factor — so consumers may
// compute effective scores at build time without ticking.
export const FRECENCY_HALF_LIFE_MS = 4 * 24 * 60 * 60 * 1000;
// Prior for a never-opened item, in access-equivalents: below one deliberate
// counted open, above the long-dead numerical tail. The registration itself is
// the evidence the user cares, and it decays away like any other access.
export const FRECENCY_COLD_START = 0.5;
export const FRECENCY_INCREMENT = 1.0;
// At most one score increment per project within this window. Rapid A↔B
// bouncing is navigation style, not engagement — counting every hop lets the
// two projects being toggled bury everything else. `lastOpened` is the
// debounce clock: it still updates on every switch, only the increment is
// suppressed.
export const FRECENCY_ACCESS_DEBOUNCE_MS = 5 * 60 * 1000;

/**
 * The score as it stands at `nowMs`, with decay applied from the moment it was
 * last written. This is the ONLY way a stored score may be compared or ranked:
 * comparing raw persisted scores compares snapshots frozen on different dates,
 * which is how a project untouched for two months once outranked last week's
 * work.
 *
 * A non-positive `lastAccessedAt` means the row predates the timestamp column;
 * treated as current (no decay) rather than inventing an epoch-sized gap.
 */
export function decayFrecencyScore(
  currentScore: number,
  lastAccessedAt: number,
  nowMs: number
): number {
  const safeScore = Number.isFinite(currentScore) && currentScore >= 0 ? currentScore : 0;
  if (safeScore === 0) return 0;
  const safeLastAccess = lastAccessedAt > 0 ? lastAccessedAt : nowMs;
  const elapsed = Math.max(0, nowMs - safeLastAccess);
  return safeScore * Math.pow(0.5, elapsed / FRECENCY_HALF_LIFE_MS);
}

/**
 * The persisted score after an access at `nowMs`: decayed to now, plus one
 * increment unless another counted access landed within the debounce window.
 * `lastOpenedAt` is the previous persisted open time — callers pass it BEFORE
 * writing the new one. A bump always re-bases the score to `nowMs`, so callers
 * must persist `lastAccessedAt = nowMs` alongside the returned score even when
 * the increment was suppressed.
 */
export function bumpFrecencyScore(
  currentScore: number,
  lastAccessedAt: number,
  lastOpenedAt: number,
  nowMs: number
): number {
  const decayed = decayFrecencyScore(currentScore, lastAccessedAt, nowMs);
  const countable = lastOpenedAt <= 0 || nowMs - lastOpenedAt >= FRECENCY_ACCESS_DEBOUNCE_MS;
  return decayed + (countable ? FRECENCY_INCREMENT : 0);
}
