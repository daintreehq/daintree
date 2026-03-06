/**
 * Linear decay from Canopy Blue to Zinc-600 over 90 seconds.
 * Uses CSS color-mix(in oklab) for perceptually accurate interpolation.
 * 0s → #6b8de6, 90s+ → #52525b
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

  return `color-mix(in oklab, #6b8de6 ${percentage}%, #52525b)`;
}
