import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import {
  ACTIVITY_HOLD_DURATION,
  DECAY_DURATION,
  getActivityColor,
} from "@/utils/colorInterpolation";
import { scheduleFlip } from "@/utils/flipScheduler";
import { isValidPastTimestamp } from "@/utils/timestamps";

interface ActivityLightProps {
  lastActivityTimestamp?: number | null;
  className?: string;
}

const FADE_CADENCE = 15_000;
const PERFORMANCE_MODE_FLOOR = 60_000;

function isActivelyWorking(timestamp: number | null | undefined): boolean {
  const now = Date.now();
  return isValidPastTimestamp(timestamp, now) && now - timestamp < DECAY_DURATION;
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
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const now = Date.now();
    if (!isValidPastTimestamp(lastActivityTimestamp, now)) return;

    const elapsed = now - lastActivityTimestamp;
    if (elapsed >= DECAY_DURATION) return;

    const fadeCadence =
      document.body.dataset.performanceMode === "true" ? PERFORMANCE_MODE_FLOOR : FADE_CADENCE;
    const delay =
      elapsed < ACTIVITY_HOLD_DURATION
        ? ACTIVITY_HOLD_DURATION - elapsed
        : Math.min(fadeCadence, DECAY_DURATION - elapsed);

    return scheduleFlip(delay, () => setTick((n) => n + 1));
  }, [lastActivityTimestamp, tick]);

  if (!isValidPastTimestamp(lastActivityTimestamp)) return null;

  void tick;
  const color = getActivityColor(lastActivityTimestamp);
  const active = isActivelyWorking(lastActivityTimestamp);

  return (
    <div
      aria-hidden="true"
      data-activity-active={active ? "true" : "false"}
      className={cn(
        "w-2.5 h-2.5 rounded-full transition-colors duration-1000 ease-linear",
        active ? "" : "border bg-transparent",
        className
      )}
      style={active ? { backgroundColor: color } : { borderColor: color }}
    />
  );
}
