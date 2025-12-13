/**
 * Linear decay from Emerald-500 to Zinc-600 over 90 seconds.
 * Uses CSS color-mix(in oklab) for perceptually accurate interpolation.
 * 0s → #10b981, 90s+ → #52525b
 */
export function getActivityColor(lastActivityTimestamp: number | null | undefined): string {
  if (lastActivityTimestamp == null || !Number.isFinite(lastActivityTimestamp)) {
    return "#52525b";
  }

  const DECAY_DURATION = 90 * 1000;
  const elapsed = Math.max(0, Date.now() - lastActivityTimestamp);

  if (elapsed >= DECAY_DURATION) {
    return "#52525b";
  }

  const factor = elapsed / DECAY_DURATION;
  const percentage = Math.max(0, Math.min(100, Math.round((1 - factor) * 100)));

  // Use CSS color-mix for perceptually accurate interpolation
  return `color-mix(in oklab, #10b981 ${percentage}%, #52525b)`;
}
