/**
 * Linear decay from accent (working) color to idle over 90 seconds.
 * Uses CSS color-mix(in oklab) for perceptually accurate interpolation.
 * Colors are read from CSS custom properties with hardcoded fallbacks.
 */

export const DECAY_DURATION = 90 * 1000;

function getCSSColor(property: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(property).trim();
  return value || fallback;
}

export function getActivityColor(lastActivityTimestamp: number | null | undefined): string {
  if (lastActivityTimestamp == null || !Number.isFinite(lastActivityTimestamp)) {
    return getCSSColor("--theme-activity-idle", "#52525b");
  }

  const elapsed = Math.max(0, Date.now() - lastActivityTimestamp);

  if (elapsed >= DECAY_DURATION) {
    return getCSSColor("--theme-activity-idle", "#52525b");
  }

  const factor = elapsed / DECAY_DURATION;
  const percentage = Math.max(0, Math.min(100, Math.round((1 - factor) * 100)));

  const accent = getCSSColor("--theme-activity-working", "#22c55e");
  const idle = getCSSColor("--theme-activity-idle", "#52525b");

  return `color-mix(in oklab, ${accent} ${percentage}%, ${idle})`;
}
