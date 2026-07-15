import { isValidPastTimestamp } from "./timestamps";

export const ACTIVITY_HOLD_DURATION = 5 * 60 * 1000;
export const DECAY_DURATION = 10 * 60 * 1000;

function getCSSColor(property: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(property).trim();
  return value || fallback;
}

export function getActivityColor(lastActivityTimestamp: number | null | undefined): string {
  const now = Date.now();
  if (!isValidPastTimestamp(lastActivityTimestamp, now)) {
    return getCSSColor("--theme-activity-idle", "#52525b");
  }

  const elapsed = now - lastActivityTimestamp;

  if (elapsed >= DECAY_DURATION) {
    return getCSSColor("--theme-activity-idle", "#52525b");
  }

  const fadeDuration = DECAY_DURATION - ACTIVITY_HOLD_DURATION;
  const factor = Math.max(0, elapsed - ACTIVITY_HOLD_DURATION) / fadeDuration;
  const percentage = Math.max(0, Math.min(100, Math.round((1 - factor) * 100)));

  const accent = getCSSColor("--theme-activity-working", "#22c55e");
  const idle = getCSSColor("--theme-activity-idle", "#52525b");

  return `color-mix(in oklab, ${accent} ${percentage}%, ${idle})`;
}
