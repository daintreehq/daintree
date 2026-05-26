import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { DECAY_DURATION, getActivityColor } from "@/utils/colorInterpolation";
import { scheduleFlip } from "@/utils/flipScheduler";

interface ActivityLightProps {
  lastActivityTimestamp?: number | null;
  className?: string;
}

// Coarsest decay-step cadence under performance mode.
const PERFORMANCE_MODE_FLOOR = 60_000;

function isActivelyWorking(timestamp: number | null | undefined): boolean {
  if (timestamp == null || !Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp < DECAY_DURATION;
}

/**
 * Activity indicator that fades from accent to idle over 90 seconds.
 * Conveys state via both colour (fade) and shape (filled dot active,
 * hollow ring idle) to satisfy WCAG 1.4.1. Decorative — usage sites
 * always render adjacent `LiveTimeAgo` text, so it is `aria-hidden`.
 *
 * Steps the colour once per second only while decaying; once the 90s
 * window has elapsed it stops scheduling entirely (the colour can no
 * longer change), so an idle dot costs nothing.
 */
export function ActivityLight({ lastActivityTimestamp, className }: ActivityLightProps) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (lastActivityTimestamp == null || !Number.isFinite(lastActivityTimestamp)) return;

    const elapsed = Date.now() - lastActivityTimestamp;
    if (elapsed >= DECAY_DURATION) return;

    const baseDelay =
      document.body.dataset.performanceMode === "true" ? PERFORMANCE_MODE_FLOOR : 1000;
    // Never sleep past the decay boundary — otherwise (e.g. at 89s in
    // performance mode) the dot would stay visually "active" for nearly a
    // minute past the 90s window.
    const delay = Math.min(baseDelay, DECAY_DURATION - elapsed);

    return scheduleFlip(delay, () => setTick((n) => n + 1));
  }, [lastActivityTimestamp, tick]);

  if (lastActivityTimestamp == null) return null;

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
