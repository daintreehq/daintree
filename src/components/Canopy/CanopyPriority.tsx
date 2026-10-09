export type CanopyPriorityTier = "urgent" | "high" | "medium" | "low" | "none";

/**
 * The 0–100 priority, in the four steps a person can tell apart at a glance.
 * The number itself is a model's guess to two significant figures at best; a
 * step is what it can honestly claim.
 */
export function priorityTier(priority: number | null): CanopyPriorityTier {
  if (priority === null || priority <= 0) return "none";
  if (priority >= 85) return "urgent";
  if (priority >= 65) return "high";
  if (priority >= 40) return "medium";
  return "low";
}

export const PRIORITY_LABEL: Record<CanopyPriorityTier, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
};
