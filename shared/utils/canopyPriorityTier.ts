import { CANOPY_NEEDS_YOU_PRIORITY, CANOPY_URGENT_PRIORITY } from "../types/ipc/canopy.js";

export type CanopyPriorityTier = "urgent" | "high" | "medium" | "low" | "none";

/**
 * The 0–100 priority, in the four steps a person can tell apart at a glance.
 * The number itself is a model's guess to two significant figures at best; a
 * step is what it can honestly claim.
 */
export function canopyPriorityTier(priority: number | null): CanopyPriorityTier {
  if (priority === null || priority <= 0) return "none";
  if (priority >= CANOPY_URGENT_PRIORITY) return "urgent";
  if (priority >= 65) return "high";
  if (priority >= 40) return "medium";
  return "low";
}

/** How far a new score may sit from the one shown and still leave the shown one standing. */
const PRIORITY_HOLD = 2;

/**
 * The priority to show when a new score arrives: the one already shown when
 * the new one is within a couple of points of it, in the same step and on the
 * same side of the "needs you" floor, since the difference is the readers'
 * noise, not news; the new one otherwise.
 */
export function heldCanopyPriority(shown: number, next: number): number {
  const needsYou = (priority: number) => priority >= CANOPY_NEEDS_YOU_PRIORITY;
  return Math.abs(next - shown) <= PRIORITY_HOLD &&
    canopyPriorityTier(next) === canopyPriorityTier(shown) &&
    needsYou(next) === needsYou(shown)
    ? shown
    : next;
}
