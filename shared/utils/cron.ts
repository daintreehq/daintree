export type CronField = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

export interface CronError {
  /** The field the message is about, or null when it is about the whole expression. */
  readonly field: CronField | null;
  readonly message: string;
}

export interface ParsedCron {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly boolean[];
  readonly months: readonly boolean[];
  /** Indexed 0-6 from Sunday; a written 7 is folded onto 0. */
  readonly daysOfWeek: readonly boolean[];
  /**
   * Whether the field was written starting with `*`, alone or with a step. This is
   * syntax, not membership: Vixie cron matches either day field when neither
   * starts with `*`, and both otherwise.
   */
  readonly dayOfMonthStarred: boolean;
  readonly dayOfWeekStarred: boolean;
}

export type CronParseResult =
  | { readonly ok: true; readonly cron: ParsedCron }
  | { readonly ok: false; readonly error: CronError };

interface FieldSpec {
  readonly field: CronField;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}

const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;
const WEEKDAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const MAX_EXPRESSION_LENGTH = 256;

// February counts 29 so a 29th-only expression stays valid; it fires in leap years.
const MAX_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const FIELD_SPECS: readonly FieldSpec[] = [
  { field: "minute", label: "Minute", min: 0, max: 59 },
  { field: "hour", label: "Hour", min: 0, max: 23 },
  { field: "dayOfMonth", label: "Day of month", min: 1, max: 31 },
  { field: "month", label: "Month", min: 1, max: 12, names: MONTH_NAMES },
  { field: "dayOfWeek", label: "Day of week", min: 0, max: 7, names: WEEKDAY_NAMES },
];

const NAME_OFFSET: Record<CronField, number> = {
  minute: 0,
  hour: 0,
  dayOfMonth: 0,
  month: 1,
  dayOfWeek: 0,
};

// Quartz and non-standard extensions, named so a pasted expression gets a
// reason rather than "isn't a number".
const UNSUPPORTED_SYNTAX: readonly { readonly pattern: RegExp; readonly token: string }[] = [
  { pattern: /\?/, token: "?" },
  { pattern: /#/, token: "#" },
  { pattern: /^\d*L$|^LW$/i, token: "L" },
  { pattern: /^\d+W$/i, token: "W" },
];

type FieldResult = { ok: true; values: boolean[] } | { ok: false; error: CronError };

function fieldError(spec: FieldSpec, message: string): FieldResult {
  return { ok: false, error: { field: spec.field, message } };
}

function parseValue(token: string, spec: FieldSpec): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  if (!spec.names) return null;
  const index = spec.names.indexOf(token.toUpperCase());
  return index === -1 ? null : index + NAME_OFFSET[spec.field];
}

function describeValueProblem(token: string, spec: FieldSpec): string {
  const unsupported = UNSUPPORTED_SYNTAX.find(({ pattern }) => pattern.test(token));
  if (unsupported) {
    return `${spec.label} uses "${unsupported.token}", which standard cron doesn't support`;
  }
  if (/^\d+$/.test(token)) {
    return `${spec.label} ${token} is out of range (${spec.min}-${spec.max})`;
  }
  if (spec.names) {
    const examples = spec.field === "month" ? "JAN-DEC" : "SUN-SAT";
    return `${spec.label} "${token}" isn't a number or a name like ${examples}`;
  }
  return `${spec.label} "${token}" isn't a number`;
}

function parseField(source: string, spec: FieldSpec): FieldResult {
  const values = new Array<boolean>(spec.max + 1).fill(false);
  for (const item of source.split(",")) {
    if (item === "") return fieldError(spec, `${spec.label} has an empty list item`);
    const slash = item.split("/");
    if (slash.length > 2) return fieldError(spec, `${spec.label} "${item}" has more than one /`);
    const [base, stepSource] = slash as [string, string | undefined];

    let step = 1;
    if (stepSource !== undefined) {
      if (!/^\d+$/.test(stepSource)) {
        return fieldError(spec, `${spec.label} step "${stepSource}" isn't a number`);
      }
      step = Number(stepSource);
      if (step < 1) return fieldError(spec, `${spec.label} step must be 1 or more`);
    }

    let start: number;
    let end: number;
    if (base === "*") {
      start = spec.min;
      end = spec.field === "dayOfWeek" ? 6 : spec.max;
    } else {
      const bounds = base.split("-");
      if (bounds.length > 2 || bounds.some((bound) => bound === "")) {
        return fieldError(spec, `${spec.label} "${base}" isn't a value or a range`);
      }
      const parsed: number[] = [];
      for (const bound of bounds) {
        const value = parseValue(bound, spec);
        if (value === null || value < spec.min || value > spec.max) {
          return fieldError(spec, describeValueProblem(bound, spec));
        }
        parsed.push(value);
      }
      start = parsed[0]!;
      end = parsed[1] ?? start;
      if (bounds.length === 1 && stepSource !== undefined) {
        return fieldError(
          spec,
          `${spec.label} "${item}" needs a range before the step, like ${start}-${spec.max}/${step}`
        );
      }
      if (end < start) return fieldError(spec, `${spec.label} range ${base} runs backwards`);
    }

    for (let value = start; value <= end; value += step) values[value] = true;
  }
  return { ok: true, values };
}

function selected(values: readonly boolean[]): number[] {
  const out: number[] = [];
  values.forEach((on, value) => {
    if (on) out.push(value);
  });
  return out;
}

/**
 * Parses a standard five-field cron expression: minute, hour, day of month,
 * month, day of week. Supports `*`, lists, ranges, `*` and range steps, and
 * three-letter month and weekday names. Both 0 and 7 mean Sunday. When day of
 * month and day of week are both restricted, a day matching either fires, as in
 * Vixie cron; a field counts as unrestricted when it starts with `*`.
 */
export function parseCron(expression: string): CronParseResult {
  const trimmed = expression.trim();
  if (trimmed === "")
    return { ok: false, error: { field: null, message: "Enter a cron expression" } };
  if (trimmed.length > MAX_EXPRESSION_LENGTH) {
    return { ok: false, error: { field: null, message: "This expression is too long for cron" } };
  }
  if (trimmed.startsWith("@")) {
    return {
      ok: false,
      error: {
        field: null,
        message: `${trimmed.split(/\s+/)[0]} isn't supported: write five fields, like 0 0 * * * for midnight every day`,
      },
    };
  }

  if (/[\r\n]/.test(trimmed)) {
    return { ok: false, error: { field: null, message: "Write the expression on one line" } };
  }
  const fields = trimmed.split(/[ \t]+/);
  if (fields.length !== 5) {
    return {
      ok: false,
      error: {
        field: null,
        message: `Use five fields (minute, hour, day of month, month, day of week), not ${fields.length}`,
      },
    };
  }

  const results: boolean[][] = [];
  for (let index = 0; index < FIELD_SPECS.length; index++) {
    const result = parseField(fields[index]!, FIELD_SPECS[index]!);
    if (!result.ok) return result;
    results.push(result.values);
  }

  const [minutes, hours, daysOfMonth, months, rawDaysOfWeek] = results as [
    boolean[],
    boolean[],
    boolean[],
    boolean[],
    boolean[],
  ];
  const daysOfWeek = rawDaysOfWeek.slice(0, 7);
  if (rawDaysOfWeek[7]) daysOfWeek[0] = true;

  const cron: ParsedCron = {
    minutes: selected(minutes),
    hours: selected(hours),
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthStarred: fields[2]!.startsWith("*"),
    dayOfWeekStarred: fields[4]!.startsWith("*"),
  };

  const neverFires = describeNeverFires(cron);
  if (neverFires) return { ok: false, error: { field: "dayOfMonth", message: neverFires } };
  return { ok: true, cron };
}

function describeNeverFires(cron: ParsedCron): string | null {
  // Either-day matching always has a weekday to fall back on. Otherwise every
  // real month-and-day falls on every weekday somewhere in the 400-year cycle,
  // so only the month lengths can make the expression unsatisfiable.
  if (!cron.dayOfMonthStarred && !cron.dayOfWeekStarred) return null;
  const chosenMonths = selected(cron.months);
  const firstDay = cron.daysOfMonth.indexOf(true);
  if (chosenMonths.some((month) => firstDay <= MAX_DAYS_IN_MONTH[month - 1]!)) return null;
  if (chosenMonths.length === 1) {
    const month = chosenMonths[0]!;
    return `This never runs: ${MONTH_LABELS[month - 1]} has at most ${MAX_DAYS_IN_MONTH[month - 1]} days`;
  }
  return "This never runs: none of the chosen months has those days";
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
// The Gregorian calendar repeats every 400 years, weekdays included, so a
// search this long finds any expression parseCron accepted.
const SEARCH_HORIZON_DAYS = 146_097;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall clock `instant` shows in `timeZone`, written as if it were a UTC time, to the second. */
function wallClockAsUtc(instant: number, timeZone: string): number {
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value);
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
    }
  }
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function offsetAt(instant: number, timeZone: string): number {
  return wallClockAsUtc(instant, timeZone) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock minute in `timeZone` fires at. A wall clock shown
 * twice (the hour repeated when clocks go back) fires at its first showing; one
 * never shown (the hour skipped when clocks go forward) fires at the moment the
 * clocks jump. Both keep the mapping in wall-clock order, which the searches
 * below rely on, and make every skipped minute land on one instant.
 *
 * The offsets in force on either side come from a day before and after, which
 * assumes no zone changes its offset twice within a day of the same minute.
 */
function wallClockToInstant(wallAsUtc: number, timeZone: string): number {
  const offsetBefore = offsetAt(wallAsUtc - DAY_MS, timeZone);
  const offsetAfter = offsetAt(wallAsUtc + DAY_MS, timeZone);
  const early = wallAsUtc - Math.max(offsetBefore, offsetAfter);
  const late = wallAsUtc - Math.min(offsetBefore, offsetAfter);
  if (wallClockAsUtc(early, timeZone) === wallAsUtc) return early;
  if (wallClockAsUtc(late, timeZone) === wallAsUtc) return late;

  // In a gap: `early` sits before the jump and `late` after it.
  let low = Math.floor(early / 1000);
  let high = Math.ceil(late / 1000);
  const offsetAfterJump = offsetAt(high * 1000, timeZone);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (offsetAt(middle * 1000, timeZone) === offsetAfterJump) high = middle;
    else low = middle;
  }
  return high * 1000;
}

function dayMatches(cron: ParsedCron, dayOfMonth: number, dayOfWeek: number): boolean {
  const byMonthDay = cron.daysOfMonth[dayOfMonth] === true;
  const byWeekday = cron.daysOfWeek[dayOfWeek] === true;
  if (cron.dayOfMonthStarred || cron.dayOfWeekStarred) return byMonthDay && byWeekday;
  return byMonthDay || byWeekday;
}

function dateMatches(cron: ParsedCron, day: number): boolean {
  const date = new Date(day * DAY_MS);
  return (
    cron.months[date.getUTCMonth() + 1] === true &&
    dayMatches(cron, date.getUTCDate(), date.getUTCDay())
  );
}

/** Firing instants of one local date, in wall-clock order (so non-decreasing). */
class DateCandidates {
  readonly length: number;

  constructor(
    private readonly cron: ParsedCron,
    private readonly timeZone: string,
    private readonly day: number
  ) {
    this.length = cron.hours.length * cron.minutes.length;
  }

  instantAt(index: number): number {
    const perHour = this.cron.minutes.length;
    const hour = this.cron.hours[Math.floor(index / perHour)]!;
    const minute = this.cron.minutes[index % perHour]!;
    return wallClockToInstant(
      this.day * DAY_MS + hour * HOUR_MS + minute * MINUTE_MS,
      this.timeZone
    );
  }
}

function localDay(instant: number, timeZone: string): number {
  return Math.floor(wallClockAsUtc(instant, timeZone) / DAY_MS);
}

function assertInstant(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite timestamp`);
}

/**
 * The first instant strictly after `afterMs` that `cron` fires at in
 * `timeZone`. Null only when the search horizon runs past the dates `Date` can
 * represent.
 */
export function nextCronOccurrence(
  cron: ParsedCron,
  timeZone: string,
  afterMs: number
): number | null {
  assertInstant("afterMs", afterMs);
  // Minutes on earlier local dates all map to instants at or before `afterMs`.
  const startDay = localDay(afterMs, timeZone);
  for (let day = startDay; day <= startDay + SEARCH_HORIZON_DAYS; day++) {
    if (!dateMatches(cron, day)) continue;
    const candidates = new DateCandidates(cron, timeZone, day);
    if (candidates.instantAt(candidates.length - 1) <= afterMs) continue;
    let low = 0;
    let high = candidates.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (candidates.instantAt(middle) > afterMs) high = middle;
      else low = middle + 1;
    }
    return candidates.instantAt(low);
  }
  return null;
}

/**
 * The last instant at or before `atMs` that `cron` fired at in `timeZone`. In
 * the second pass of a repeated hour this can be a minute whose wall clock is
 * later than the one `atMs` shows, because that minute fired in the first pass.
 */
export function previousCronOccurrence(
  cron: ParsedCron,
  timeZone: string,
  atMs: number
): number | null {
  assertInstant("atMs", atMs);
  // A repeated hour can put an earlier instant's minutes on the next local date.
  const startDay = localDay(atMs, timeZone) + 1;
  for (let day = startDay; day >= startDay - SEARCH_HORIZON_DAYS; day--) {
    if (!dateMatches(cron, day)) continue;
    const candidates = new DateCandidates(cron, timeZone, day);
    if (candidates.instantAt(0) > atMs) continue;
    let low = 0;
    let high = candidates.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (candidates.instantAt(middle) <= atMs) low = middle;
      else high = middle - 1;
    }
    return candidates.instantAt(low);
  }
  return null;
}

/** Up to `count` successive, distinct firing instants strictly after `afterMs`. */
export function nextCronOccurrences(
  cron: ParsedCron,
  timeZone: string,
  afterMs: number,
  count: number
): number[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError("count must be a non-negative integer");
  }
  const out: number[] = [];
  let cursor = afterMs;
  while (out.length < count) {
    const next = nextCronOccurrence(cron, timeZone, cursor);
    if (next === null) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

export type TimeZoneValidation =
  | { readonly ok: true; readonly timeZone: string }
  | { readonly ok: false; readonly message: string };

/**
 * Accepts IANA names and their aliases, case-insensitively, and returns the
 * name Intl resolves them to. Numeric offsets such as `+05:00` are refused:
 * they never follow daylight saving, which a named zone does.
 */
export function validateTimeZone(timeZone: string): TimeZoneValidation {
  const trimmed = timeZone.trim();
  if (trimmed === "") return { ok: false, message: "Choose a time zone" };
  if (/^[+-]\d/.test(trimmed)) {
    return { ok: false, message: "Use a named time zone, such as Europe/London, not an offset" };
  }
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions()
      .timeZone;
    return { ok: true, timeZone: resolved };
  } catch {
    return { ok: false, message: `"${trimmed}" isn't a time zone this system knows` };
  }
}

/** The machine's IANA time zone, or UTC when the runtime can't name one. */
export function machineTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && validateTimeZone(zone).ok ? zone : "UTC";
  } catch {
    return "UTC";
  }
}
