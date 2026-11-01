import { parseCron, validateTimeZone, type ParsedCron } from "./cron.js";

export type SystemdCalendarResult =
  | { readonly ok: true; readonly specs: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** February counts 29 days, as cron's own check of a date that can never come does. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function chosen(values: readonly boolean[], min: number, max: number): number[] {
  const out: number[] = [];
  for (let value = min; value <= max; value++) if (values[value]) out.push(value);
  return out;
}

/** A field as systemd writes it: `*` when it covers its whole range, else a plain list. */
function field(values: readonly number[], size: number): string {
  if (values.length === size) return "*";
  return values.map((value) => String(value).padStart(2, "0")).join(",");
}

function spec(weekdays: readonly number[] | null, date: string, time: string): string {
  const prefix = weekdays === null ? "" : `${weekdays.map((day) => WEEKDAYS[day]).join(",")} `;
  return `${prefix}${date} ${time}`;
}

/**
 * Vixie cron's day rule as `OnCalendar=` lines. Cron ORs the two day fields
 * when neither starts with `*` and ANDs them otherwise. systemd ANDs a weekday
 * and a date in one line and ORs separate lines, so it holds both rules.
 */
function daySpecs(cron: ParsedCron, months: readonly number[], time: string): string[] {
  const longest = Math.max(...months.map((month) => MONTH_DAYS[month - 1]!));
  // A day no chosen month has, which only either-day matching can leave behind.
  const allDays = chosen(cron.daysOfMonth, 1, 31);
  const days = allDays.filter((day) => day <= longest);
  const weekdays = chosen(cron.daysOfWeek, 0, 6);
  const everyDay = allDays.length === 31;
  const everyWeekday = weekdays.length === 7;
  const monthField = field(months, 12);
  const date = (dayField: string) => `*-${monthField}-${dayField}`;

  if (!cron.dayOfMonthStarred && !cron.dayOfWeekStarred) {
    if (everyDay || everyWeekday) return [spec(null, date("*"), time)];
    return [
      ...(days.length > 0 ? [spec(null, date(field(days, 31)), time)] : []),
      spec(weekdays, date("*"), time),
    ];
  }
  if (everyDay && everyWeekday) return [spec(null, date("*"), time)];
  if (everyDay) return [spec(weekdays, date("*"), time)];
  if (everyWeekday) return [spec(null, date(field(days, 31)), time)];
  return [spec(weekdays, date(field(days, 31)), time)];
}

/**
 * The `OnCalendar=` lines that start a systemd timer at exactly a schedule's
 * occurrences, or why they can't. They carry no zone, so the user manager reads
 * them in the machine's own zone, and a schedule in another zone is refused
 * rather than converted: an offset that holds today moves at the next
 * daylight-saving change.
 */
export function systemdCalendarFor(
  cadence: { readonly cron: string; readonly timeZone: string },
  machineZone: string
): SystemdCalendarResult {
  const parsed = parseCron(cadence.cron);
  if (!parsed.ok) return { ok: false, reason: parsed.error.message };
  const scheduleZone = validateTimeZone(cadence.timeZone);
  if (!scheduleZone.ok) return { ok: false, reason: scheduleZone.message };
  const systemZone = validateTimeZone(machineZone);
  if (!systemZone.ok || scheduleZone.timeZone !== systemZone.timeZone) {
    return {
      ok: false,
      reason: `systemd can only start Daintree on this computer's time (${machineZone}), and this schedule runs on ${cadence.timeZone} time`,
    };
  }
  const cron = parsed.cron;
  const time = `${field(cron.hours, 24)}:${field(cron.minutes, 60)}:00`;
  return { ok: true, specs: daySpecs(cron, chosen(cron.months, 1, 12), time) };
}
