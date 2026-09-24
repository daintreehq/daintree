import { cn } from "@/lib/utils";
import {
  ACTIVITY_HOLD_DURATION,
  DECAY_DURATION,
  getActivityColor,
} from "@/utils/colorInterpolation";
import { useWallClock } from "@/hooks/useWallClock";
import { isValidPastTimestamp } from "@/utils/timestamps";

interface ActivityLightProps {
  lastActivityTimestamp?: number | null;
  className?: string;
}

const FADE_CADENCE = 15_000;
const PERFORMANCE_MODE_FLOOR = 60_000;

function isActivelyWorking(timestamp: number, now: number): boolean {
  return now - timestamp < DECAY_DURATION;
}

function nextFlipDelay(timestamp: number | null | undefined, now: number): number | null {
  if (!isValidPastTimestamp(timestamp, now)) return null;
  const elapsed = now - timestamp;
  if (elapsed >= DECAY_DURATION) return null;
  const fadeCadence =
    document.body.dataset.performanceMode === "true" ? PERFORMANCE_MODE_FLOOR : FADE_CADENCE;
  return elapsed < ACTIVITY_HOLD_DURATION
    ? ACTIVITY_HOLD_DURATION - elapsed
    : Math.min(fadeCadence, DECAY_DURATION - elapsed);
}

/**
 * Activity indicator that holds the working colour for five minutes, then
 * fades to idle over the next five minutes.
 * Conveys state via both colour (fade) and shape (filled dot active,
 * hollow ring idle) to satisfy WCAG 1.4.1. Decorative — usage sites
 * always render adjacent `LiveTimeAgo` text, so it is `aria-hidden`.
 *
 * It sleeps through the solid-colour hold, uses a coarse cadence only while
 * fading, and stops scheduling entirely once idle.
 */
export function ActivityLight({ lastActivityTimestamp, className }: ActivityLightProps) {
  const now = useWallClock(lastActivityTimestamp, (at) => nextFlipDelay(lastActivityTimestamp, at));

  if (!isValidPastTimestamp(lastActivityTimestamp, now)) return null;

  const color = getActivityColor(lastActivityTimestamp, now);
  const active = isActivelyWorking(lastActivityTimestamp, now);

  return (
    <div
      aria-hidden="true"
      data-activity-active={active ? "true" : "false"}
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-1000 ease-linear",
        active ? "" : "border bg-transparent",
        className
      )}
      style={active ? { backgroundColor: color } : { borderColor: color }}
    />
  );
}
