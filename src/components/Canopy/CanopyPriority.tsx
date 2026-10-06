import { cn } from "@/lib/utils";

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

const FILLED_BARS: Record<CanopyPriorityTier, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

/** Bar heights on a 16-unit grid, rising left to right. */
const BAR_HEIGHTS = [4, 7, 10, 13] as const;

/**
 * A reception meter for the priority step: four rising bars, the step's count
 * filled and the rest drawn faint, so how full it is reads at a glance and
 * without colour (WCAG 1.4.1). It stays neutral, leaving the accent and the
 * state hues to the things that own them.
 */
export function CanopyPriorityGlyph({
  tier,
  className,
}: {
  tier: CanopyPriorityTier;
  className?: string;
}) {
  const filled = FILLED_BARS[tier];
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      data-filled={filled}
      className={cn(
        "size-4 shrink-0",
        tier === "urgent" || tier === "high" ? "text-text-primary" : "text-text-secondary",
        className
      )}
    >
      {BAR_HEIGHTS.map((height, index) => (
        <rect
          key={height}
          x={1 + index * 3.75}
          y={14.5 - height}
          width={2.5}
          height={height}
          rx={0.75}
          fill="currentColor"
          opacity={index < filled ? 1 : 0.22}
        />
      ))}
    </svg>
  );
}
