import { parseCron, validateTimeZone } from "./cron.js";
import { chosen, dayRule, type DayRule } from "./cronDayRule.js";
import { pluralize } from "./pluralize.js";

/** The days a calendar trigger starts on. Weekdays are 0-6 from Sunday, months 1-12. */
export type TaskTriggerDays =
  | { readonly kind: "daily" }
  | { readonly kind: "weekly"; readonly weekdays: readonly number[] }
  | {
      readonly kind: "monthly";
      readonly days: readonly number[];
      readonly months: readonly number[];
    }
  | {
      readonly kind: "monthly-weekdays";
      readonly weekdays: readonly number[];
      readonly months: readonly number[];
    };

/**
 * One Task Scheduler calendar trigger: on each of its days, a start at
 * `startMinute` past local midnight and, with `repeat`, `count - 1` more
 * `everyMinutes` apart.
 */
export interface TaskTrigger {
  readonly days: TaskTriggerDays;
  readonly startMinute: number;
  readonly repeat: { readonly everyMinutes: number; readonly count: number } | null;
}

export type TaskTriggersResult =
  | { readonly ok: true; readonly triggers: readonly TaskTrigger[] }
  | { readonly ok: false; readonly reason: string };

/** Task Scheduler's own limit for one task, which holds every schedule's triggers. */
export const MAX_TASK_TRIGGERS = 48;

const EVERY_DAY_OF_MONTH: readonly number[] = Array.from({ length: 31 }, (_, i) => i + 1);

/** The step of evenly spaced values; 0 for one value, null when they aren't evenly spaced. */
function step(values: readonly number[]): number | null {
  if (values.length < 2) return 0;
  const gap = values[1]! - values[0]!;
  for (let i = 2; i < values.length; i++) if (values[i]! - values[i - 1]! !== gap) return null;
  return gap;
}

type TimeSlot = Pick<TaskTrigger, "startMinute" | "repeat">;

function slot(startMinute: number, everyMinutes: number, count: number): TimeSlot {
  return { startMinute, repeat: count > 1 ? { everyMinutes, count } : null };
}

/**
 * The start times of a day as the fewest triggers: one repeating run when
 * they're evenly spaced across the day, one run per hour when the minutes
 * are, one run per minute when the hours are, or one trigger per time. On a
 * tie the run that stays inside an hour wins, since Windows counts a
 * repetition in elapsed time and a clock change moves those that cross it.
 */
function timeAxis(hours: readonly number[], minutes: readonly number[]): TimeSlot[] {
  const times = hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute));
  const candidates: TimeSlot[][] = [];
  const minuteStep = step(minutes);
  if (minuteStep !== null) {
    candidates.push(hours.map((hour) => slot(hour * 60 + minutes[0]!, minuteStep, minutes.length)));
  }
  const timeStep = step(times);
  if (timeStep !== null) candidates.push([slot(times[0]!, timeStep, times.length)]);
  const hourStep = step(hours);
  if (hourStep !== null) {
    candidates.push(
      minutes.map((minute) => slot(hours[0]! * 60 + minute, hourStep * 60, hours.length))
    );
  }
  candidates.push(times.map((time) => slot(time, 0, 1)));
  return candidates.reduce((best, next) => (next.length < best.length ? next : best));
}

function dayAxis(rule: DayRule, months: readonly number[]): TaskTriggerDays[] {
  const everyMonth = months.length === 12;
  const byDays = (days: readonly number[]): TaskTriggerDays => ({ kind: "monthly", days, months });
  // Weeks 1-4 and Last of a month cover every showing of a weekday in it.
  const byWeekdays = (weekdays: readonly number[]): TaskTriggerDays =>
    everyMonth ? { kind: "weekly", weekdays } : { kind: "monthly-weekdays", weekdays, months };
  switch (rule.kind) {
    case "any":
      return [everyMonth ? { kind: "daily" } : byDays(EVERY_DAY_OF_MONTH)];
    case "days":
      return [byDays(rule.days)];
    case "weekdays":
      return [byWeekdays(rule.weekdays)];
    case "either":
      return [byDays(rule.days), byWeekdays(rule.weekdays)];
  }
}

/**
 * The calendar triggers that start a task at exactly a schedule's
 * occurrences, or why there can't be. Task Scheduler reads a trigger with no
 * zone in the PC's own time, so a schedule in another zone is refused rather
 * than converted: an offset that holds today moves at the next daylight-saving
 * change. Nothing is approximated by starting more often, since each start
 * launches Daintree.
 */
export function taskSchedulerTriggersFor(
  cadence: { readonly cron: string; readonly timeZone: string },
  machineZone: string
): TaskTriggersResult {
  const parsed = parseCron(cadence.cron);
  if (!parsed.ok) return { ok: false, reason: parsed.error.message };
  const scheduleZone = validateTimeZone(cadence.timeZone);
  if (!scheduleZone.ok) return { ok: false, reason: scheduleZone.message };
  const systemZone = validateTimeZone(machineZone);
  if (!systemZone.ok || scheduleZone.timeZone !== systemZone.timeZone) {
    return {
      ok: false,
      reason: `Windows can only start Daintree on this PC's time (${machineZone}), and this schedule runs on ${cadence.timeZone} time`,
    };
  }
  const cron = parsed.cron;
  const rule = dayRule(cron);
  if (!rule) {
    return {
      ok: false,
      reason:
        "Windows can't start Daintree only on days that match both the day of the month and the weekday",
    };
  }
  const days = dayAxis(rule, chosen(cron.months, 1, 12));
  const times = timeAxis(cron.hours, cron.minutes);
  const count = days.length * times.length;
  if (count > MAX_TASK_TRIGGERS) {
    return {
      ok: false,
      reason: `Windows would need ${pluralize(count, "trigger")} for this cadence, more than the ${MAX_TASK_TRIGGERS} its task can hold`,
    };
  }
  return {
    ok: true,
    triggers: days.flatMap((day) => times.map((time) => ({ days: day, ...time }))),
  };
}

/** A stable identity for a trigger, so the same trigger from two schedules is written once. */
export function taskTriggerKey(trigger: TaskTrigger): string {
  const { days } = trigger;
  const parts: string[] = [days.kind];
  if (days.kind === "weekly" || days.kind === "monthly-weekdays")
    parts.push(days.weekdays.join(","));
  if (days.kind === "monthly") parts.push(days.days.join(","));
  if (days.kind === "monthly" || days.kind === "monthly-weekdays")
    parts.push(days.months.join(","));
  const repeat = trigger.repeat ? `${trigger.repeat.everyMinutes}x${trigger.repeat.count}` : "once";
  return `${parts.join(" ")} @${String(trigger.startMinute).padStart(4, "0")} ${repeat}`;
}

export interface TaskTriggerFit {
  /** Every fitting schedule's triggers, each written once, in a stable order. */
  readonly triggers: readonly TaskTrigger[];
  /** Per schedule, in the order given: null when it fits, else why it was left out. */
  readonly reasons: readonly (string | null)[];
}

/**
 * Fits schedules into the one task in the order given, so the earliest keep
 * their place. A schedule whose new triggers would take the task past its
 * limit is left out whole, and a later, smaller one may still fit.
 */
export function fitTaskTriggers(perSchedule: readonly (readonly TaskTrigger[])[]): TaskTriggerFit {
  const byKey = new Map<string, TaskTrigger>();
  const reasons = perSchedule.map((triggers) => {
    const added = new Map<string, TaskTrigger>();
    for (const trigger of triggers) {
      const key = taskTriggerKey(trigger);
      if (!byKey.has(key)) added.set(key, trigger);
    }
    if (byKey.size + added.size > MAX_TASK_TRIGGERS) {
      return `Windows' task holds at most ${pluralize(MAX_TASK_TRIGGERS, "trigger")}, and schedules made before this one already use ${pluralize(byKey.size, "trigger")}`;
    }
    for (const [key, trigger] of added) byKey.set(key, trigger);
    return null;
  });
  const triggers = [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, trigger]) => trigger);
  return { triggers, reasons };
}
