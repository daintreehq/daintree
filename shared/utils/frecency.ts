export const FRECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
// Exploration bias for never-accessed items: ~3 half-lives of stickiness so a
// new item can accrue real frequency before decay buries it under a single
// recent access of an older item. Without this seed, one click on a stale
// favourite would drop a cold item below it for days.
export const FRECENCY_COLD_START = 3.0;
export const FRECENCY_INCREMENT = 1.0;

export function computeFrecencyScore(
  currentScore: number,
  lastAccessedAt: number,
  nowMs: number
): number {
  const safeScore = Number.isFinite(currentScore) && currentScore >= 0 ? currentScore : 0;
  const safeLastAccess = lastAccessedAt > 0 ? lastAccessedAt : nowMs;
  const elapsed = Math.max(0, nowMs - safeLastAccess);
  const decayed = safeScore * Math.pow(0.5, elapsed / FRECENCY_HALF_LIFE_MS);
  return decayed + FRECENCY_INCREMENT;
}
