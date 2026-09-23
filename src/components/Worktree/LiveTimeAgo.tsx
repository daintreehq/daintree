import { useEffect, useState } from "react";
import { scheduleFlip } from "@/utils/flipScheduler";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isValidPastTimestamp } from "@/utils/timestamps";

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

// Lazy module-level singletons — Intl formatter construction is expensive and
// the options never vary, so don't rebuild them on every virtualized row mount.
let absoluteFormatter: Intl.DateTimeFormat | undefined;
let currentYearFormatter: Intl.DateTimeFormat | undefined;

function getAbsoluteFormatter(): Intl.DateTimeFormat {
  return (absoluteFormatter ??= new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }));
}

/**
 * The compact absolute label. The year is dropped while it is the current one:
 * it carries no information there, and "May 6, 2026" takes nearly twice the
 * width of "May 6" from whatever text the label sits beside.
 */
export function formatAbsoluteDate(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  if (date.getFullYear() !== new Date(now).getFullYear()) {
    return getAbsoluteFormatter().format(date);
  }
  return (currentYearFormatter ??= new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  })).format(date);
}

/** Milliseconds until local midnight on 1 January, when a yearless label gains its year. */
function msUntilNextYear(now: number): number {
  const next = new Date(new Date(now).getFullYear() + 1, 0, 1);
  return next.getTime() - now;
}

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
 *
 * Boundaries are measured on the elapsed age, not the wall clock: "1h" becomes
 * "2h" two hours after the activity, not at the next top of the hour.
 */
export function msUntilNextFlip(diffMs: number, now: number): number {
  const untilUnit = (unit: number) => unit - (diffMs % unit);
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days >= 30) return msUntilNextYear(now);
  if (seconds < 5) return 5000 - diffMs;
  if (seconds < 60) return untilUnit(1000);
  if (minutes < 60) return untilUnit(MINUTE);
  if (hours < 24) return untilUnit(HOUR);
  if (days < 7) return untilUnit(DAY);
  return Math.min(untilUnit(WEEK), 30 * DAY - diffMs);
}

export function LiveTimeAgo({ timestamp, className, noTooltip }: LiveTimeAgoProps) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const now = Date.now();
    if (!isValidPastTimestamp(timestamp, now)) return;

    let delay = msUntilNextFlip(now - timestamp, now);
    if (document.body.dataset.performanceMode === "true") {
      delay = Math.max(delay, PERFORMANCE_MODE_FLOOR);
    }

    return scheduleFlip(delay, () => setTick((n) => n + 1));
  }, [timestamp, tick]);

  if (!isValidPastTimestamp(timestamp)) {
    return null;
  }

  void tick;
  const now = Date.now();
  const diffMs = now - timestamp;
  const { label, fullLabel, isAbsolute } = formatTimeAgo(diffMs);
  const isoDate = new Date(timestamp).toISOString();

  if (isAbsolute) {
    const absoluteLabel = formatAbsoluteDate(timestamp, now);
    const timeEl = (
      <time
        dateTime={isoDate}
        className={cn("tabular-nums", className)}
        aria-label={getAbsoluteFormatter().format(new Date(timestamp))}
      >
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
