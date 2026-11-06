import { parseCron, type ParsedCron } from "@shared/utils/cron";

// The cadence picker's state (#15985). The expression stays the source of
// truth: a picker state is read from it when the editor opens, and every
// picker edit writes a new one. Each preset writes one text form, so the
// state it was picked in is the state it reopens in, `1-5` (Every weekday)
// and `1,2,3,4,5` (the same days, chosen) included.

export type CadenceKind = "interval" | "daily" | "weekdays" | "days" | "monthly" | "custom";

export interface CadenceChoice {
  readonly kind: CadenceKind;
  /** Minutes between runs, one of `INTERVAL_MINUTES`. */
  readonly everyMinutes: number;
  /** Minutes after midnight. */
  readonly time: number;
  /** Days of the week, 0-6 from Sunday, ascending. */
  readonly days: readonly number[];
  /** Day of the month, 1-31. */
  readonly monthDay: number;
  /** The expression this choice saves; empty while the choice is incomplete. */
  readonly cron: string;
}

/**
 * Steps that divide the hour or the day, so every gap between runs is the same:
 * a 7-minute step counts from :00 each hour, which leaves a 4-minute gap at :56.
 */
export const INTERVAL_MINUTES: readonly number[] = [
  1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720,
];

export const WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

const DEFAULT_TIME = 9 * 60;
const DEFAULT_INTERVAL = 60;
const DEFAULT_DAYS: readonly number[] = [1];
const DEFAULT_MONTH_DAY = 1;

function selected(values: readonly boolean[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let value = from; value <= to; value++) if (values[value]) out.push(value);
  return out;
}

/** `0, step, 2×step …` through the whole field, else null. */
function stepOf(values: readonly number[], fieldSize: number): number | null {
  if (values.length === fieldSize) return 1;
  if (values.length < 2 || values[0] !== 0) return null;
  const step = values[1]!;
  if (fieldSize % step !== 0 || values.length !== fieldSize / step) return null;
  return values.every((value, index) => value === index * step) ? step : null;
}

function intervalOf(cron: ParsedCron): number | null {
  const minuteStep = cron.hours.length === 24 ? stepOf(cron.minutes, 60) : null;
  if (minuteStep !== null) return minuteStep;
  if (cron.minutes.length !== 1 || cron.minutes[0] !== 0) return null;
  const hourStep = stepOf(cron.hours, 24);
  return hourStep === null ? null : hourStep * 60;
}

/**
 * What a preset can take from an expression even when no preset writes it, so
 * moving from custom to a preset keeps the time, days or day already written.
 */
function seedsOf(cron: ParsedCron): Partial<CadenceChoice> {
  const seeds: { -readonly [K in keyof CadenceChoice]?: CadenceChoice[K] } = {};
  const interval = intervalOf(cron);
  if (interval !== null && INTERVAL_MINUTES.includes(interval)) seeds.everyMinutes = interval;
  if (cron.minutes.length === 1 && cron.hours.length === 1) {
    seeds.time = cron.hours[0]! * 60 + cron.minutes[0]!;
  }
  const weekdays = selected(cron.daysOfWeek, 0, 6);
  if (weekdays.length < 7) seeds.days = weekdays;
  const monthDays = selected(cron.daysOfMonth, 1, 31);
  if (monthDays.length === 1) seeds.monthDay = monthDays[0]!;
  return seeds;
}

/** The picker state an expression opens in: a preset when one writes it, else custom. */
export function choiceFromCron(expression: string): CadenceChoice {
  const parsed = parseCron(expression);
  const custom: CadenceChoice = {
    kind: "custom",
    everyMinutes: DEFAULT_INTERVAL,
    time: DEFAULT_TIME,
    days: DEFAULT_DAYS,
    monthDay: DEFAULT_MONTH_DAY,
    ...(parsed.ok ? seedsOf(parsed.cron) : {}),
    cron: expression,
  };
  if (!parsed.ok) return custom;
  const cron = parsed.cron;
  const monthDays = selected(cron.daysOfMonth, 1, 31);
  const weekdays = selected(cron.daysOfWeek, 0, 6);
  const everyMonth = selected(cron.months, 1, 12).length === 12;
  const everyDate = monthDays.length === 31 && cron.dayOfWeekStarred && weekdays.length === 7;
  if (!everyMonth) return custom;

  const interval = intervalOf(cron);
  if (interval !== null && everyDate) {
    return INTERVAL_MINUTES.includes(interval)
      ? { ...custom, kind: "interval", everyMinutes: interval }
      : custom;
  }

  if (cron.minutes.length !== 1 || cron.hours.length !== 1) return custom;
  const at = { ...custom, time: cron.hours[0]! * 60 + cron.minutes[0]! };
  if (everyDate) return { ...at, kind: "daily" };

  // A restricted day of week counts only while day of month is `*`; with both
  // restricted, cron fires on either, which no preset writes.
  if (cron.dayOfMonthStarred && !cron.dayOfWeekStarred && monthDays.length === 31) {
    const dayField = expression.trim().split(/\s+/)[4] ?? "";
    if (/^(1-5|mon-fri)$/i.test(dayField)) return { ...at, kind: "weekdays", days: WEEKDAYS };
    return { ...at, kind: "days", days: weekdays };
  }

  if (!cron.dayOfMonthStarred && cron.dayOfWeekStarred && monthDays.length === 1) {
    return { ...at, kind: "monthly", monthDay: monthDays[0]! };
  }
  return custom;
}

/** The expression a preset writes, or null when it needs more (no day chosen). */
function presetCron(choice: CadenceChoice): string | null {
  const minute = choice.time % 60;
  const hour = Math.floor(choice.time / 60);
  switch (choice.kind) {
    case "interval":
      if (choice.everyMinutes === 1) return "* * * * *";
      if (choice.everyMinutes < 60) return `*/${choice.everyMinutes} * * * *`;
      return choice.everyMinutes === 60 ? "0 * * * *" : `0 */${choice.everyMinutes / 60} * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "days":
      return choice.days.length === 0
        ? null
        : `${minute} ${hour} * * ${[...choice.days].sort((a, b) => a - b).join(",")}`;
    case "monthly":
      return `${minute} ${hour} ${choice.monthDay} * *`;
    case "custom":
      return choice.cron;
  }
}

/** A changed choice with its expression written again from the preset's fields. */
export function withChoice(choice: CadenceChoice, change: Partial<CadenceChoice>): CadenceChoice {
  const next = { ...choice, ...change };
  if (next.kind === "custom") return next;
  return { ...next, cron: presetCron(next) ?? "" };
}

/**
 * Moves to another kind keeping what carries over: the time of day, and the
 * days Every weekday stood for. Custom starts from the expression in use.
 */
export function switchKind(choice: CadenceChoice, kind: CadenceKind): CadenceChoice {
  if (kind === choice.kind) return choice;
  if (kind === "custom") return { ...choice, kind };
  // A typed expression is newer than the fields it was started from.
  const parsed = choice.kind === "custom" ? parseCron(choice.cron) : null;
  const from = parsed?.ok ? { ...choice, ...seedsOf(parsed.cron) } : choice;
  const days = kind === "days" && from.kind === "weekdays" ? WEEKDAYS : from.days;
  return withChoice(from, { kind, days: days.length === 0 ? DEFAULT_DAYS : days });
}

/** Why the choice can't be saved yet, before the expression is checked. */
export function choiceIssue(choice: CadenceChoice): string | null {
  return choice.kind === "days" && choice.days.length === 0 ? "Choose at least one day" : null;
}
