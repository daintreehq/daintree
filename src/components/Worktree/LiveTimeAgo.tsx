import { useEffect, useState } from "react";
import { scheduleFlip } from "@/utils/flipScheduler";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface LiveTimeAgoProps {
  timestamp?: number | null;
  className?: string;
  noTooltip?: boolean;
}

// Coarsest update cadence when the app is in performance mode — even a fast
// "Xs" label may lag by up to a minute rather than waking a timer per second.
const PERFORMANCE_MODE_FLOOR = 60_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function formatTimeAgo(diffMs: number): { label: string; fullLabel: string; isAbsolute?: boolean } {
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let label: string;
  let fullLabel: string;

  if (days >= 30) {
    return { label: "", fullLabel: "", isAbsolute: true };
  }

  if (seconds < 5) {
    label = "now";
    fullLabel = "just now";
  } else if (seconds < 60) {
    label = `${seconds}s`;
    fullLabel = `${seconds} seconds ago`;
  } else if (minutes < 60) {
    label = `${minutes}m`;
    fullLabel = `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
  } else if (hours < 24) {
    label = `${hours}h`;
    fullLabel = `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  } else if (days < 7) {
    label = `${days}d`;
    fullLabel = `${days} day${days !== 1 ? "s" : ""} ago`;
  } else {
    const weeks = Math.floor(days / 7);
    label = `${weeks}w`;
    fullLabel = `${weeks} week${weeks !== 1 ? "s" : ""} ago`;
  }

  return { label, fullLabel };
}

/**
 * Milliseconds until the formatted label can next change. Mirrors the bucket
 * boundaries in `formatTimeAgo` so an hours/days/weeks-old timestamp schedules
 * a single far-future wake instead of ticking every second.
 */
function msUntilNextFlip(diffMs: number, now: number): number {
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days >= 30) return Infinity;
  if (seconds < 5) return 5000 - diffMs;
  if (seconds < 60) return 1000 - (now % 1000);
  if (minutes < 60) return MINUTE - (now % MINUTE);
  if (hours < 24) return HOUR - (now % HOUR);
  if (days < 7) return DAY - (now % DAY);
  if (days < 30) return WEEK - (now % WEEK);
  return Infinity;
}

export function LiveTimeAgo({ timestamp, className, noTooltip }: LiveTimeAgoProps) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (timestamp == null || !Number.isFinite(timestamp)) return;

    const now = Date.now();
    let delay = msUntilNextFlip(now - timestamp, now);
    if (document.body.dataset.performanceMode === "true") {
      delay = Math.max(delay, PERFORMANCE_MODE_FLOOR);
    }

    return scheduleFlip(delay, () => setTick((n) => n + 1));
  }, [timestamp, tick]);

  if (timestamp == null || !Number.isFinite(timestamp)) {
    return null;
  }

  void tick;
  const diffMs = Date.now() - timestamp;
  const { label, fullLabel, isAbsolute } = formatTimeAgo(diffMs);
  const isoDate = new Date(timestamp).toISOString();

  if (isAbsolute) {
    const absoluteLabel = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(timestamp)
    );
    const timeEl = (
      <time dateTime={isoDate} className={cn("tabular-nums", className)}>
        {absoluteLabel}
      </time>
    );
    if (noTooltip) return timeEl;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{timeEl}</TooltipTrigger>
        <TooltipContent side="bottom">{`Last activity: ${new Date(timestamp).toLocaleString()}`}</TooltipContent>
      </Tooltip>
    );
  }

  const formattedDate = new Date(timestamp).toLocaleString();

  const timeEl = (
    <time dateTime={isoDate} className={cn("tabular-nums", className)} aria-label={fullLabel}>
      {label}
    </time>
  );
  if (noTooltip) return timeEl;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{timeEl}</TooltipTrigger>
      <TooltipContent side="bottom">{`${fullLabel} (${formattedDate})`}</TooltipContent>
    </Tooltip>
  );
}
