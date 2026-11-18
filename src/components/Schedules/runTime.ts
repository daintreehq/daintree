import { machineTimeZone } from "@shared/utils/cron";

// Every zone a schedule names gets its own formatters, so a form typing zones by
// hand shouldn't grow the cache without bound.
const FORMATTER_CACHE_LIMIT = 32;
const formatters = new Map<string, Intl.DateTimeFormat>();

// Building a formatter resolves its locale and zone, which costs far more than
// formatting with it, and a column of runs asks for the same few again and again.
function dateTimeFormat(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = `${locale ?? ""} ${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (formatters.size >= FORMATTER_CACHE_LIMIT) formatters.clear();
    formatters.set(key, formatter);
  }
  return formatter;
}

/** The calendar year of an instant in a zone. */
function yearIn(epochMs: number, timeZone: string): number {
  return Number(dateTimeFormat("en-US", { timeZone, year: "numeric" }).format(epochMs));
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
  return dateTimeFormat(undefined, {
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

/** A run's instant, and its date and wall-clock time as the schedule's zone reads them. */
export interface RunParts {
  at: number;
  day: string;
  time: string;
}

/**
 * A column of runs as the schedule's zone reads them, and whether that zone is
 * foreign here. The machine's zone is read once for the whole column, so every
 * row and the column's caption agree on it.
 */
export function formatRunColumn(
  runs: readonly number[],
  timeZone: string,
  now: number
): { foreign: boolean; rows: RunParts[] } {
  const foreign = timeZone !== machineTimeZone();
  // Held for the whole column, so the shared cache clearing partway through it
  // never rebuilds one.
  const year = dateTimeFormat("en-US", { timeZone, year: "numeric" });
  const time = dateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    ...(foreign ? { timeZoneName: "short" } : {}),
  });
  const dayFormat = (withYear: boolean) =>
    dateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone,
      ...(withYear ? { year: "numeric" } : {}),
    });
  const thisYear = year.format(now);
  let sameYearDay: Intl.DateTimeFormat | undefined;
  let otherYearDay: Intl.DateTimeFormat | undefined;
  const rows = runs.map((run) => {
    const day =
      year.format(run) === thisYear
        ? (sameYearDay ??= dayFormat(false))
        : (otherYearDay ??= dayFormat(true));
    return { at: run, day: day.format(run), time: time.format(run) };
  });
  return { foreign, rows };
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** The local calendar date of an instant in a zone, as a day count for subtraction. */
export function localDayNumber(epochMs: number, timeZone: string): number {
  const parts = dateTimeFormat("en-US", {
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
