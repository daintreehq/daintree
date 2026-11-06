import { parseCron, type ParsedCron } from "./cron.js";

// A cadence in words for the Schedules view (#15984): "Every day at 9:00 AM",
// "Weekdays at 2:00 AM", "Every 15 minutes". Read from what the expression
// selects rather than from its text, so `0 9 * * 1-5` and `0 9 * * MON,TUE,WED,THU,FRI`
// read the same. Anything without a short honest reading answers null and the
// caller shows the expression itself.

const WEEKDAY_PLURALS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
] as const;
const MONTH_WORDS = [
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

/** More times than this in a day reads better as the expression. */
const MAX_LISTED_TIMES = 4;
const MAX_LISTED_DAYS_OF_MONTH = 3;
const MAX_LISTED_MONTHS = 3;

function selected(values: readonly boolean[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let value = from; value <= to; value++) if (values[value]) out.push(value);
  return out;
}

/**
 * The step when `values` is `0, step, 2×step, …` to the field's end and the step
 * divides the field, else null: a 40-minute step fires at :00 and :40, gaps of 40
 * then 20 minutes, so it is not "every 40 minutes".
 */
function evenStep(values: readonly number[], fieldSize: number): number | null {
  if (values.length < 2 || values[0] !== 0) return null;
  const step = values[1]!;
  if (step < 2 || fieldSize % step !== 0) return null;
  for (let index = 1; index < values.length; index++) {
    if (values[index]! - values[index - 1]! !== step) return null;
  }
  return values[values.length - 1]! + step >= fieldSize ? step : null;
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

function clockTime(hour: number, minute: number, locale: string | undefined): string {
  // UTC on both sides, so the wall clock the expression names is the one printed.
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(Date.UTC(2000, 0, 1, hour, minute));
}

interface DayWords {
  /** Leads a sentence: "Weekdays", "Mondays and Fridays", "On the 1st of the month". */
  readonly lead: string;
  /** Follows an interval: "on weekdays", "on the 1st of the month". */
  readonly trailing: string;
}

function weekdayWords(days: readonly number[]): DayWords {
  const key = days.join(",");
  if (key === "1,2,3,4,5") return { lead: "Weekdays", trailing: "on weekdays" };
  if (key === "0,6") return { lead: "Weekends", trailing: "on weekends" };
  // Monday first, the way a working week is read.
  const ordered = [...days.filter((day) => day !== 0), ...days.filter((day) => day === 0)];
  const names = joinWords(ordered.map((day) => WEEKDAY_PLURALS[day]!));
  return { lead: names, trailing: `on ${names}` };
}

function monthDayWords(days: readonly number[]): DayWords | null {
  if (days.length > MAX_LISTED_DAYS_OF_MONTH) return null;
  const phrase = `the ${joinWords(days.map(ordinal))} of the month`;
  return { lead: `On ${phrase}`, trailing: `on ${phrase}` };
}

/** Null for every day; undefined when the days have no short reading. */
function dayWords(cron: ParsedCron): DayWords | null | undefined {
  const monthDays = selected(cron.daysOfMonth, 1, 31);
  const weekdays = selected(cron.daysOfWeek, 0, 6);
  const everyMonthDay = monthDays.length === 31;
  const everyWeekday = weekdays.length === 7;
  // Vixie cron fires on either day field only when neither starts with `*`, so
  // there one full field (`1-31`, `0-6`) means every day, whatever the other says.
  const eitherDay = !cron.dayOfMonthStarred && !cron.dayOfWeekStarred;

  if (everyMonthDay && everyWeekday) return null;
  if (eitherDay && (everyMonthDay || everyWeekday)) return null;
  if (everyMonthDay) return weekdayWords(weekdays);
  if (everyWeekday) return monthDayWords(monthDays) ?? undefined;
  if (!eitherDay) return undefined;
  const byDate = monthDayWords(monthDays);
  if (!byDate) return undefined;
  const byWeekday = weekdayWords(weekdays);
  return {
    lead: `${byDate.lead} and ${byWeekday.trailing}`,
    trailing: `${byDate.trailing} and ${byWeekday.trailing}`,
  };
}

/** "" for every month; undefined when there are too many to list. */
function monthWords(cron: ParsedCron): string | undefined {
  const months = selected(cron.months, 1, 12);
  if (months.length === 12) return "";
  if (months.length > MAX_LISTED_MONTHS) return undefined;
  return ` in ${joinWords(months.map((month) => MONTH_WORDS[month - 1]!))}`;
}

/** An interval through the day ("Every 15 minutes"), or null when the times are a list. */
function intervalWords(minutes: readonly number[], hours: readonly number[]): string | null {
  const everyHour = hours.length === 24;
  if (everyHour && minutes.length === 60) return "Every minute";
  const minuteStep = evenStep(minutes, 60);
  if (everyHour && minuteStep !== null) return `Every ${minuteStep} minutes`;
  if (everyHour && minutes.length === 1) {
    return minutes[0] === 0
      ? "Every hour"
      : `Every hour at :${String(minutes[0]).padStart(2, "0")}`;
  }
  const hourStep = minutes.length === 1 && minutes[0] === 0 ? evenStep(hours, 24) : null;
  if (hourStep !== null) return `Every ${hourStep} hours`;
  return null;
}

export function describeParsedCron(cron: ParsedCron, locale?: string): string | null {
  const days = dayWords(cron);
  const months = monthWords(cron);
  if (days === undefined || months === undefined) return null;
  const minutes = cron.minutes;
  const hours = cron.hours;

  const interval = intervalWords(minutes, hours);
  if (interval !== null) {
    return `${interval}${days ? `, ${days.trailing}` : ""}${months}`;
  }

  if (minutes.length * hours.length > MAX_LISTED_TIMES) return null;
  const times: string[] = [];
  for (const hour of hours) {
    for (const minute of minutes) times.push(clockTime(hour, minute, locale));
  }
  return `${days ? days.lead : "Every day"} at ${joinWords(times)}${months}`;
}

/** The expression in words, or null when it is invalid or has no short reading. */
export function describeCron(expression: string, locale?: string): string | null {
  const parsed = parseCron(expression);
  return parsed.ok ? describeParsedCron(parsed.cron, locale) : null;
}
