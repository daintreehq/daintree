// Calendar days as ISO strings ("2026-09-30"), with no date library.
//
// A day is not an instant, so nothing here goes through the local clock's
// zone: arithmetic runs on UTC day numbers (no daylight-saving hour can move a
// day) and every label is formatted with `timeZone: "UTC"` from a UTC
// midnight, which names the same day the string does. Only `todayIso` reads
// the local zone, because "today" is the user's wall-clock day.

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;

export interface DateRange {
  start: string;
  end: string;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return utcDate(year, month + 1, 0).getUTCDate();
}

// `Date.UTC` maps years 0–99 onto 1900–1999, so the year is set separately.
function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function isoFromParts(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1 || year > 9999 || month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** The ISO day `value` names, or null when it is not a real `YYYY-MM-DD` date. */
export function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  return isoFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** A `YYYY-MM` month key, or null. */
export function toIsoMonth(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ISO_MONTH.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year >= 1 && month >= 1 && month <= 12 ? value : null;
}

/** A range with both ends real days, ordered; null otherwise. */
export function toDateRange(value: unknown): DateRange | null {
  if (typeof value !== "object" || value === null) return null;
  const start = toIsoDate(Reflect.get(value, "start"));
  const end = toIsoDate(Reflect.get(value, "end"));
  if (start === null || end === null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

function parts(iso: string): [number, number, number] {
  return [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))];
}

export function dayNumber(iso: string): number {
  const [year, month, day] = parts(iso);
  return Math.round(utcDate(year, month, day).getTime() / DAY_MS);
}

function fromDayNumber(value: number): string {
  const date = new Date(value * DAY_MS);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

export function addDays(iso: string, days: number): string {
  return fromDayNumber(dayNumber(iso) + days);
}

/** Same day number in the month `months` away, clamped to that month's length. */
export function addMonths(iso: string, months: number): string {
  const [year, month, day] = parts(iso);
  const index = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(index / 12);
  const nextMonth = (index % 12) + 1;
  return isoFromParts(nextYear, nextMonth, Math.min(day, daysInMonth(nextYear, nextMonth))) ?? iso;
}

/** 0 is Sunday. */
export function weekday(iso: string): number {
  // Day 0 of the epoch, 1970-01-01, was a Thursday.
  return (((dayNumber(iso) + 4) % 7) + 7) % 7;
}

export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

export function firstOfMonth(month: string): string {
  return `${month}-01`;
}

export function shiftMonth(month: string, months: number): string {
  return monthOf(addMonths(firstOfMonth(month), months));
}

export function monthDistance(from: string, to: string): number {
  const [fromYear, fromMonth] = parts(firstOfMonth(from));
  const [toYear, toMonth] = parts(firstOfMonth(to));
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

export function clampIso(iso: string, min: string | null, max: string | null): string {
  if (min !== null && iso < min) return min;
  if (max !== null && iso > max) return max;
  return iso;
}

/** The user's wall-clock day at `now`. */
export function todayIso(now: number): string {
  const date = new Date(now);
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** Milliseconds until the next local midnight, when "today" moves on. */
export function msUntilLocalMidnight(now: number): number {
  const date = new Date(now);
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return next.getTime() - now;
}

/**
 * The days of `month` laid out in weeks starting on `weekStart`, padded with
 * null to six full weeks so a month never changes the grid's height.
 */
export function monthWeeks(month: string, weekStart: number): (string | null)[][] {
  const first = firstOfMonth(month);
  const [year, monthNumber] = parts(first);
  const lead = (weekday(first) - weekStart + 7) % 7;
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  const length = daysInMonth(year, monthNumber);
  for (let day = 1; day <= length; day++) cells.push(addDays(first, day - 1));
  while (cells.length < 42) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let index = 0; index < 42; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

// ── Locale ────────────────────────────────────────────────────────────────

// Regions whose week starts on Sunday, for engines without `getWeekInfo`
// (CLDR's list, trimmed to the populous ones; Saturday starts fall to Monday).
const SUNDAY_REGIONS = new Set([
  "US",
  "CA",
  "MX",
  "BR",
  "JP",
  "KR",
  "TW",
  "HK",
  "IL",
  "PH",
  "IN",
  "ID",
  "TH",
  "ZA",
  "AU",
  "SA",
  "AR",
  "CO",
  "PE",
  "VE",
  "GT",
  "PR",
  "DO",
  "PK",
  "BD",
  "KE",
  "ET",
  "NG",
  "SG",
  "MO",
]);

let cachedWeekStart: number | undefined;

function readWeekStart(): number {
  try {
    const tag = new Intl.DateTimeFormat().resolvedOptions().locale;
    const locale = new Intl.Locale(tag);
    // `getWeekInfo()` in current engines, the `weekInfo` getter in the first
    // ones to ship it; `firstDay` counts Monday as 1 and Sunday as 7.
    const getWeekInfo = Reflect.get(locale, "getWeekInfo");
    const info: unknown =
      typeof getWeekInfo === "function"
        ? getWeekInfo.call(locale)
        : Reflect.get(locale, "weekInfo");
    if (typeof info === "object" && info !== null) {
      const firstDay = Reflect.get(info, "firstDay");
      if (typeof firstDay === "number" && firstDay >= 1 && firstDay <= 7) return firstDay % 7;
    }
    const region = locale.maximize().region;
    return region !== undefined && SUNDAY_REGIONS.has(region) ? 0 : 1;
  } catch {
    return 1;
  }
}

/** The first day of the week in the user's locale, 0 for Sunday. */
export function localeWeekStart(): number {
  cachedWeekStart ??= readWeekStart();
  return cachedWeekStart;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" });
    formatters.set(key, cached);
  }
  return cached;
}

function utcOf(iso: string): Date {
  const [year, month, day] = parts(iso);
  return utcDate(year, month, day);
}

/** "September 2026". */
export function formatMonthLabel(month: string): string {
  return formatter("month", { month: "long", year: "numeric" }).format(utcOf(firstOfMonth(month)));
}

/** "Wednesday, September 30, 2026": a day cell's accessible name. */
export function formatFullDate(iso: string): string {
  return formatter("full", { dateStyle: "full" }).format(utcOf(iso));
}

/**
 * "Sep 30, 2026": what the field shows. Named month, as the host's own dates
 * are, so it never reads differently from one locale to the next.
 */
export function formatFieldDate(iso: string): string {
  return formatter("field", { year: "numeric", month: "short", day: "numeric" }).format(utcOf(iso));
}

export function formatDayNumber(iso: string): string {
  return formatter("day", { day: "numeric" }).format(utcOf(iso));
}

// 2023-01-01 was a Sunday, so the week from it gives every weekday name.
const SUNDAY = "2023-01-01";

const weekdayCache = new Map<number, readonly { short: string; long: string }[]>();

export function weekdayNames(weekStart: number): readonly { short: string; long: string }[] {
  let names = weekdayCache.get(weekStart);
  if (!names) {
    names = Array.from({ length: 7 }, (_, offset) => {
      const date = utcOf(addDays(SUNDAY, (weekStart + offset) % 7));
      return {
        short: formatter("weekday-short", { weekday: "short" }).format(date),
        long: formatter("weekday-long", { weekday: "long" }).format(date),
      };
    });
    weekdayCache.set(weekStart, names);
  }
  return names;
}

export const RANGE_SEPARATOR = " – ";

export function formatFieldRange(range: DateRange): string {
  return `${formatFieldDate(range.start)}${RANGE_SEPARATOR}${formatFieldDate(range.end)}`;
}

// ── Lenient parsing ──────────────────────────────────────────────────────

const ENGLISH_MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

let monthNameIndex: Map<string, number> | undefined;

/** Every spelling of a month the parser accepts: English and the locale's, long and short. */
function monthNames(): Map<string, number> {
  if (monthNameIndex) return monthNameIndex;
  const index = new Map<string, number>();
  const add = (name: string, month: number) => {
    const key = name.toLocaleLowerCase().replace(/\.$/, "");
    if (key && !index.has(key)) index.set(key, month);
  };
  ENGLISH_MONTHS.forEach((name, month) => {
    add(name, month + 1);
    add(name.slice(0, 3), month + 1);
    if (name.length > 4) add(name.slice(0, 4), month + 1);
  });
  for (let month = 1; month <= 12; month++) {
    const date = utcOf(`2023-${pad(month, 2)}-15`);
    add(formatter("parse-long", { month: "long" }).format(date), month);
    add(formatter("parse-short", { month: "short" }).format(date), month);
  }
  monthNameIndex = index;
  return index;
}

let numericOrder: ("day" | "month" | "year")[] | undefined;

/** Where the locale puts day, month and year in a numeric date: US month first, most day first. */
function localeNumericOrder(): ("day" | "month" | "year")[] {
  if (numericOrder) return numericOrder;
  const order = formatter("numeric", { year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(utcOf("2023-11-22"))
    .map((part) => part.type)
    .filter(
      (type): type is "day" | "month" | "year" =>
        type === "day" || type === "month" || type === "year"
    );
  numericOrder = order.length === 3 ? order : ["month", "day", "year"];
  return numericOrder;
}

function fullYear(text: string): number {
  const value = Number(text);
  return text.length <= 2 ? 2000 + value : value;
}

/**
 * The day typed into a date field, or null when it is not one. Accepts ISO
 * (`2026-09-30`, `2026/9/30`, `20260930`), the locale's numeric order
 * (`9/30/2026` in en-US, `30.09.2026` in de-DE), and a month name with or
 * without a year (`Sep 30 2026`, `30 September`); a missing year is the one
 * `today` falls in.
 */
export function parseDateText(text: string, today: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  let match = /^(\d{4})[-/.\s](\d{1,2})[-/.\s](\d{1,2})$/.exec(trimmed);
  if (match) return isoFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (match) return isoFromParts(Number(match[1]), Number(match[2]), Number(match[3]));

  match = /^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{2}|\d{4})\.?$/.exec(trimmed);
  if (match) {
    const values: Record<"day" | "month" | "year", string> = { day: "", month: "", year: "" };
    const order = localeNumericOrder().filter((part) => part !== "year");
    values[order[0]!] = match[1]!;
    values[order[1]!] = match[2]!;
    values.year = match[3]!;
    return isoFromParts(fullYear(values.year), Number(values.month), Number(values.day));
  }

  const tokens = trimmed.toLocaleLowerCase().match(/[\p{L}]+\.?|\d+/gu) ?? [];
  const names = monthNames();
  let month: number | undefined;
  let day: number | undefined;
  let year: number | undefined;
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      if (token.length === 4 && year === undefined) year = Number(token);
      else if (token.length <= 2 && day === undefined) day = Number(token);
      else if (token.length <= 2 && year === undefined) year = fullYear(token);
      else return null;
      continue;
    }
    const named = names.get(token.replace(/\.$/, ""));
    if (named !== undefined && month === undefined) {
      month = named;
      continue;
    }
    // Ordinal suffixes ("30th") and weekday names are noise; anything else is not a date.
    if (/^(st|nd|rd|th|de|of|the)$/.test(token)) continue;
    return null;
  }
  if (month === undefined || day === undefined) return null;
  return isoFromParts(year ?? Number(today.slice(0, 4)), month, day);
}

// En and em dashes with or without spaces, a hyphen or "to" only with spaces:
// an ISO date is full of hyphens.
const RANGE_SPLIT = /\s*[–—]\s*|\s+-\s+|\s+to\s+/i;

/** A typed range, or null. Two dates in either order; one date is a one-day range. */
export function parseRangeText(text: string, today: string): DateRange | null {
  const pieces = text.trim().split(RANGE_SPLIT);
  if (pieces.length === 1) {
    const day = parseDateText(pieces[0]!, today);
    return day === null ? null : { start: day, end: day };
  }
  if (pieces.length !== 2) return null;
  const start = parseDateText(pieces[0]!, today);
  const end = parseDateText(pieces[1]!, today);
  if (start === null || end === null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}
