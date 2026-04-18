import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { DECAY_DURATION, getActivityColor } from "@/utils/colorInterpolation";
import { useGlobalSecondTicker } from "@/hooks/useGlobalSecondTicker";

interface ActivityLightProps {
  lastActivityTimestamp?: number | null;
  className?: string;
}

function isActivelyWorking(timestamp: number | null | undefined): boolean {
  if (timestamp == null || !Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp < DECAY_DURATION;
}

/**
 * Activity indicator that fades from accent to idle over 90 seconds.
 * Conveys state via both colour (fade) and shape (filled dot active,
 * hollow ring idle) to satisfy WCAG 1.4.1. Decorative — usage sites
 * always render adjacent `LiveTimeAgo` text, so it is `aria-hidden`.
 */
export function ActivityLight({ lastActivityTimestamp, className }: ActivityLightProps) {
  const globalTick = useGlobalSecondTicker();
  const [color, setColor] = useState(() => getActivityColor(lastActivityTimestamp));
  const [active, setActive] = useState(() => isActivelyWorking(lastActivityTimestamp));

  useEffect(() => {
    setColor(getActivityColor(lastActivityTimestamp));
    setActive(isActivelyWorking(lastActivityTimestamp));
  }, [lastActivityTimestamp, globalTick]);

  return (
    <div
      aria-hidden="true"
      className={cn(
        "w-2.5 h-2.5 rounded-full transition-colors duration-1000 ease-linear",
        active ? "" : "border bg-transparent",
        className
      )}
      style={active ? { backgroundColor: color } : { borderColor: color }}
    />
  );
}
