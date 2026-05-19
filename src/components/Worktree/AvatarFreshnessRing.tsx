import { useState, useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DECAY_DURATION, getActivityColor } from "@/utils/colorInterpolation";
import { scheduleFlip } from "@/utils/flipScheduler";

interface AvatarFreshnessRingProps {
  lastActivityTimestamp?: number | null;
  shape?: "circle" | "square";
  children: ReactNode;
}

// Coarsest decay-step cadence under performance mode.
const PERFORMANCE_MODE_FLOOR = 60_000;

/**
 * Wraps an avatar with a freshness ring that fades from accent to idle over
 * 90 seconds, mirroring `ActivityLight`'s decay machinery. The ring is drawn
 * as an outset `box-shadow` so it occupies zero layout space — the wrapper is
 * always exactly the avatar's size, no reflow as the colour decays.
 *
 * Unlike `ActivityLight`, the ring renders even when there is no activity
 * timestamp (resolves to the muted idle colour, no timer armed) so the
 * committer chip's avatar always carries a consistent edge treatment.
 *
 * Decorative — usage sites render adjacent `LiveTimeAgo` text, so the ring
 * element is `aria-hidden`. The `avatar-freshness-ring` class lets the global
 * `@variant reduce-motion` rule snap the transition.
 */
export function AvatarFreshnessRing({
  lastActivityTimestamp,
  shape = "circle",
  children,
}: AvatarFreshnessRingProps) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (lastActivityTimestamp == null || !Number.isFinite(lastActivityTimestamp)) return;

    const elapsed = Date.now() - lastActivityTimestamp;
    if (elapsed >= DECAY_DURATION) return;

    const baseDelay =
      document.body.dataset.performanceMode === "true" ? PERFORMANCE_MODE_FLOOR : 1000;
    // Never sleep past the decay boundary — otherwise (e.g. at 89s in
    // performance mode) the ring would stay visually "active" for nearly a
    // minute past the 90s window.
    const delay = Math.min(baseDelay, DECAY_DURATION - elapsed);

    return scheduleFlip(delay, () => setTick((n) => n + 1));
  }, [lastActivityTimestamp, tick]);

  void tick;
  const color = getActivityColor(lastActivityTimestamp);
  const radius = shape === "square" ? "rounded-md" : "rounded-full";

  return (
    <div className="relative inline-flex shrink-0">
      {children}
      <div
        aria-hidden="true"
        className={cn(
          "avatar-freshness-ring pointer-events-none absolute inset-0 transition-shadow duration-1000 ease-linear",
          radius
        )}
        style={{ boxShadow: `0 0 0 1.5px ${color}` }}
      />
    </div>
  );
}
