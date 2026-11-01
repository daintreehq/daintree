import { parseCron, validateTimeZone, type ParsedCron } from "./cron.js";

/**
 * One `StartCalendarInterval` entry of a launchd job. A missing key is a
 * wildcard. Keys are launchd's own, so an entry serializes as written.
 */
export interface LaunchdCalendarInterval {
  readonly Month?: number;
  readonly Day?: number;
  readonly Weekday?: number;
  readonly Hour?: number;
  readonly Minute?: number;
}

export type LaunchdCalendarResult =
  | { readonly ok: true; readonly intervals: readonly LaunchdCalendarInterval[] }
  | { readonly ok: false; readonly reason: string };

/**
 * The most calendar entries one schedule may add to the job. launchd sets no
 * limit, but every entry is a timer it keeps for the job, and a cadence past
 * this (every minute of the working day on chosen weekdays) is better served
 * by leaving Daintree running.
 */
export const MAX_LAUNCHD_INTERVALS_PER_SCHEDULE = 500;

type DayRule =
  | { readonly kind: "any" }
  | { readonly kind: "days"; readonly days: readonly number[] }
  | { readonly kind: "weekdays"; readonly weekdays: readonly number[] }
  | {
      readonly kind: "either";
      readonly days: readonly number[];
      readonly weekdays: readonly number[];
    };

function chosen(values: readonly boolean[], min: number, max: number): number[] {
  const out: number[] = [];
  for (let value = min; value <= max; value++) if (values[value]) out.push(value);
  return out;
}

/**
 * Vixie cron's day rule as launchd entries, or null when launchd can't hold
 * it. Cron ORs the two day fields when neither starts with `*` and ANDs them
 * otherwise. launchd ORs a Day and a Weekday in one entry, but the OR is
 * written as separate entries so nothing leans on that, and it has no AND.
 */
function dayRule(cron: ParsedCron): DayRule | null {
  const days = chosen(cron.daysOfMonth, 1, 31);
  const weekdays = chosen(cron.daysOfWeek, 0, 6);
  const everyDay = days.length === 31;
  const everyWeekday = weekdays.length === 7;
  if (!cron.dayOfMonthStarred && !cron.dayOfWeekStarred) {
    return everyDay || everyWeekday ? { kind: "any" } : { kind: "either", days, weekdays };
  }
  if (everyDay && everyWeekday) return { kind: "any" };
  if (everyDay) return { kind: "weekdays", weekdays };
  if (everyWeekday) return { kind: "days", days };
  return null;
}

/** Each value as a key, or one wildcard entry when the field covers its whole range. */
function axis<K extends keyof LaunchdCalendarInterval>(
  key: K,
  values: readonly number[],
  size: number
): LaunchdCalendarInterval[] {
  if (values.length === size) return [{}];
  return values.map((value) => ({ [key]: value }) as LaunchdCalendarInterval);
}

function dayAxis(rule: DayRule): LaunchdCalendarInterval[] {
  switch (rule.kind) {
    case "any":
      return [{}];
    case "days":
      return rule.days.map((Day) => ({ Day }));
    case "weekdays":
      return rule.weekdays.map((Weekday) => ({ Weekday }));
    case "either":
      return [
        ...rule.days.map((Day) => ({ Day })),
        ...rule.weekdays.map((Weekday) => ({ Weekday })),
      ];
  }
}

/**
 * The launchd calendar that starts a job at exactly a schedule's occurrences,
 * or why it can't. launchd reads its calendar in the Mac's own time zone, so a
 * schedule in another zone is refused rather than converted: an offset that
 * holds today moves at the next daylight-saving change. Nothing is ever
 * approximated by firing more often, since each firing starts Daintree.
 */
export function launchdCalendarFor(
  cadence: { readonly cron: string; readonly timeZone: string },
  machineZone: string
): LaunchdCalendarResult {
  const parsed = parseCron(cadence.cron);
  if (!parsed.ok) return { ok: false, reason: parsed.error.message };
  const scheduleZone = validateTimeZone(cadence.timeZone);
  if (!scheduleZone.ok) return { ok: false, reason: scheduleZone.message };
  const systemZone = validateTimeZone(machineZone);
  if (!systemZone.ok || scheduleZone.timeZone !== systemZone.timeZone) {
    return {
      ok: false,
      reason: `macOS starts it on this Mac's time zone (${machineZone}), and this schedule runs on ${cadence.timeZone} time`,
    };
  }
  const cron = parsed.cron;
  const rule = dayRule(cron);
  if (!rule) {
    return {
      ok: false,
      reason:
        "macOS can't start it only on days that match both the day of the month and the weekday",
    };
  }

  const months = axis("Month", chosen(cron.months, 1, 12), 12);
  const days = dayAxis(rule);
  const hours = axis("Hour", cron.hours, 24);
  // An entry with no keys at all is every minute too, but spelled out so
  // nothing leans on launchd reading an empty entry that way.
  const wildcard = (entries: readonly LaunchdCalendarInterval[]) =>
    entries.length === 1 && Object.keys(entries[0]!).length === 0;
  const minutes = [months, days, hours].every(wildcard)
    ? cron.minutes.map((Minute) => ({ Minute }))
    : axis("Minute", cron.minutes, 60);
  const count = months.length * days.length * hours.length * minutes.length;
  if (count > MAX_LAUNCHD_INTERVALS_PER_SCHEDULE) {
    return {
      ok: false,
      reason: `macOS would need ${count} start times for this cadence, more than the ${MAX_LAUNCHD_INTERVALS_PER_SCHEDULE} a schedule can use`,
    };
  }

  const intervals: LaunchdCalendarInterval[] = [];
  for (const month of months) {
    for (const day of days) {
      for (const hour of hours) {
        for (const minute of minutes) intervals.push({ ...month, ...day, ...hour, ...minute });
      }
    }
  }
  return { ok: true, intervals };
}

const KEY_ORDER: readonly (keyof LaunchdCalendarInterval)[] = [
  "Month",
  "Day",
  "Weekday",
  "Hour",
  "Minute",
];

/** A stable identity for an entry, so the same entry from two schedules is written once. */
export function launchdIntervalKey(interval: LaunchdCalendarInterval): string {
  return KEY_ORDER.map((key) => interval[key] ?? "*").join(" ");
}
