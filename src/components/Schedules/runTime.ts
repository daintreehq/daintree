import { machineTimeZone } from "@shared/utils/cron";

/** The calendar year of an instant in a zone. */
function yearIn(epochMs: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(epochMs));
}

/**
 * A run's instant as the schedule's own zone reads it ("Mon, Nov 2, 2:00 AM").
 * The zone is named only when it isn't this machine's: a schedule keeps the zone
 * it was made in, so after travel its times are not the clock on the wall. The
 * year is named only when it isn't this one.
 */
export function formatRunInstant(
  epochMs: number,
  timeZone: string,
  now: number = Date.now()
): string {
  const foreign = timeZone !== machineTimeZone();
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    ...(yearIn(epochMs, timeZone) !== yearIn(now, timeZone) ? { year: "numeric" } : {}),
    ...(foreign ? { timeZoneName: "short" } : {}),
  }).format(epochMs);
}

/** A run's date and its wall-clock time as the schedule's zone reads them, for a column of runs. */
export function formatRunParts(
  epochMs: number,
  timeZone: string,
  now: number
): { day: string; time: string } {
  const foreign = timeZone !== machineTimeZone();
  return {
    day: new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone,
      ...(yearIn(epochMs, timeZone) !== yearIn(now, timeZone) ? { year: "numeric" } : {}),
    }).format(epochMs),
    time: new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      ...(foreign ? { timeZoneName: "short" } : {}),
    }).format(epochMs),
  };
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** The local calendar date of an instant in a zone, as a day count for subtraction. */
export function localDayNumber(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(epochMs);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Math.round(Date.UTC(read("year"), read("month") - 1, read("day")) / 86_400_000);
}

/**
 * How soon a run is: minutes, then hours within a day, then calendar days in the
 * schedule's zone, so 3:15 AM the day after tomorrow never reads "tomorrow".
 */
export function formatNextRunRelative(epochMs: number, now: number, timeZone: string): string {
  const minutes = Math.round((epochMs - now) / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return RELATIVE.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return RELATIVE.format(hours, "hour");
  return RELATIVE.format(localDayNumber(epochMs, timeZone) - localDayNumber(now, timeZone), "day");
}
