import { canopyPriorityTier, type CanopyPriorityTier } from "@shared/utils/canopyPriorityTier";

export type { CanopyPriorityTier };

export const priorityTier = canopyPriorityTier;

export const PRIORITY_LABEL: Record<CanopyPriorityTier, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
};
