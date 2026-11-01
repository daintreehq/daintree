import { describe, expect, it } from "vitest";
import { nextCronOccurrence, parseCron } from "../cron.js";
import {
  MAX_TASK_TRIGGERS,
  fitTaskTriggers,
  taskSchedulerTriggersFor,
  taskTriggerKey,
  type TaskTrigger,
} from "../taskSchedulerTriggers.js";

const DAY_MS = 86_400_000;

function triggers(cron: string): readonly TaskTrigger[] {
  const result = taskSchedulerTriggersFor({ cron, timeZone: "UTC" }, "UTC");
  if (!result.ok) throw new Error(`${cron}: ${result.reason}`);
  return result.triggers;
}

function refusal(cron: string, timeZone = "UTC", machineZone = "UTC"): string {
  const result = taskSchedulerTriggersFor({ cron, timeZone }, machineZone);
  if (result.ok) throw new Error(`${cron} was accepted`);
  return result.reason;
}

function startsOn(trigger: TaskTrigger, date: Date): boolean {
  const { days } = trigger;
  const month = date.getUTCMonth() + 1;
  switch (days.kind) {
    case "daily":
      return true;
    case "weekly":
      return days.weekdays.includes(date.getUTCDay());
    case "monthly":
      return days.months.includes(month) && days.days.includes(date.getUTCDate());
    case "monthly-weekdays":
      return days.months.includes(month) && days.weekdays.includes(date.getUTCDay());
  }
}

/** Task Scheduler's reading of the triggers in a zone with no clock changes. */
function taskFirings(list: readonly TaskTrigger[], from: number, days: number): number[] {
  const out: number[] = [];
  for (let day = 0; day < days; day++) {
    const start = from + day * DAY_MS;
    const minutes = new Set<number>();
    for (const trigger of list) {
      if (!startsOn(trigger, new Date(start))) continue;
      const count = trigger.repeat?.count ?? 1;
      for (let k = 0; k < count; k++) {
        const minute = trigger.startMinute + k * (trigger.repeat?.everyMinutes ?? 0);
        // A repetition past midnight would start on the next day too.
        expect(minute).toBeLessThan(1440);
        minutes.add(minute);
      }
    }
    for (const minute of [...minutes].sort((a, b) => a - b)) out.push(start + minute * 60_000);
  }
  return out;
}

function cronFirings(expression: string, from: number, days: number): number[] {
  const parsed = parseCron(expression);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const end = from + days * DAY_MS;
  const out: number[] = [];
  for (let at = nextCronOccurrence(parsed.cron, "UTC", from - 1); at !== null && at < end;) {
    out.push(at);
    at = nextCronOccurrence(parsed.cron, "UTC", at);
  }
  return out;
}

describe("taskSchedulerTriggersFor", () => {
  it.each([
    ["0 9 * * *", 1],
    ["0 9 * * 1-5", 1],
    ["0 * * * *", 1],
    ["*/15 * * * *", 1],
    ["*/30 9-17 * * 1-5", 1],
    ["0 9,17 * * *", 1],
    ["0,30 9,12,15 * * *", 2],
    ["*/7 9-17 * * *", 9],
    ["30 8,13,17 * * *", 3],
    ["5 0 1,15 * *", 1],
    ["0 9 * 1,6 1", 1],
    ["0 9 1 * 1", 2],
    ["0 0 31 * *", 1],
    ["0 0 29 2 *", 1],
    ["15 10 * 3-5 *", 1],
    ["0 9 */2 * *", 1],
  ])("starts %s at exactly its occurrences with %i trigger(s)", (cron, count) => {
    const list = triggers(cron);
    expect(list).toHaveLength(count);
    // Two leap years and the years between, from a Monday.
    const from = Date.UTC(2027, 11, 27);
    const days = 3 * 366 + 2;
    expect(taskFirings(list, from, days)).toEqual(cronFirings(cron, from, days));
  });

  it("starts every minute with one trigger", () => {
    const list = triggers("* * * * *");
    expect(list).toHaveLength(1);
    const from = Date.UTC(2028, 1, 27);
    expect(taskFirings(list, from, 4)).toEqual(cronFirings("* * * * *", from, 4));
  });

  it("writes a whole-day run as one repetition from midnight", () => {
    expect(triggers("*/15 * * * *")).toEqual([
      { days: { kind: "daily" }, startMinute: 0, repeat: { everyMinutes: 15, count: 96 } },
    ]);
  });

  it("keeps a run within the hour when that costs no more triggers", () => {
    // Two runs either way: 9:00 and 12:00 each twenty minutes apart, or
    // 9:00 and 9:20 each three hours apart.
    expect(triggers("0,20 9,12 * * *")).toEqual([
      { days: { kind: "daily" }, startMinute: 540, repeat: { everyMinutes: 20, count: 2 } },
      { days: { kind: "daily" }, startMinute: 720, repeat: { everyMinutes: 20, count: 2 } },
    ]);
  });

  it("writes weekdays in chosen months as every week of those months", () => {
    expect(triggers("0 9 * 1,6 1")).toEqual([
      {
        days: { kind: "monthly-weekdays", weekdays: [1], months: [1, 6] },
        startMinute: 540,
        repeat: null,
      },
    ]);
  });

  it("writes either day field as separate triggers", () => {
    expect(triggers("0 9 1 * 1").map((trigger) => trigger.days)).toEqual([
      { kind: "monthly", days: [1], months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
      { kind: "weekly", weekdays: [1] },
    ]);
  });

  it("refuses a schedule in a zone other than the PC's", () => {
    expect(refusal("0 9 * * *", "Europe/London", "America/New_York")).toBe(
      "Windows can only start Daintree on this PC's time (America/New_York), and this schedule runs on Europe/London time"
    );
  });

  it("accepts a schedule written in the PC's zone", () => {
    const result = taskSchedulerTriggersFor(
      { cron: "0 9 * * *", timeZone: "Europe/London" },
      "Europe/London"
    );
    expect(result.ok).toBe(true);
  });

  it("refuses days that must match both day fields", () => {
    expect(refusal("0 0 */2 * MON")).toMatch(/both the day of the month and the weekday/);
  });

  it("refuses a cadence that needs more triggers than a task holds", () => {
    expect(refusal("0,7,13 0,1,3,7,8,10,13,15,16,20,22,23 1 * 1")).toBe(
      `Windows would need 72 triggers for this cadence, more than the ${MAX_TASK_TRIGGERS} its task can hold`
    );
  });

  it("passes on the parser's message for a cron it can't read", () => {
    expect(refusal("61 * * * *")).toMatch(/minute/i);
  });
});

describe("fitTaskTriggers", () => {
  const daily = (hour: number) => triggers(`0 ${hour} * * *`);

  it("writes a trigger two schedules share once, in a stable order", () => {
    const fit = fitTaskTriggers([daily(17), daily(9), daily(9)]);
    expect(fit.reasons).toEqual([null, null, null]);
    expect(fit.triggers.map(taskTriggerKey)).toEqual(
      [...daily(9), ...daily(17)].map(taskTriggerKey)
    );
  });

  it("leaves out a schedule that would overflow the task and keeps fitting later ones", () => {
    const many = (minute: number) => triggers(`${minute} 0,1,3,7,8,10,13,15,16,20,22,23 * * *`);
    const thirteen = triggers("4 0,1,2,3,7,8,10,13,15,16,20,22,23 * * *");
    expect(thirteen).toHaveLength(13);
    const fit = fitTaskTriggers([many(1), many(2), many(3), thirteen, daily(9)]);
    expect(fit.reasons).toEqual([
      null,
      null,
      null,
      `Windows' task holds at most ${MAX_TASK_TRIGGERS} triggers, and schedules made before this one already use 36 triggers`,
      null,
    ]);
    expect(fit.triggers).toHaveLength(37);
  });

  it("takes a task filled to its limit, and nothing past it", () => {
    const many = (minute: number) => triggers(`${minute} 0,1,3,7,8,10,13,15,16,20,22,23 * * *`);
    const full = fitTaskTriggers([many(1), many(2), many(3), many(4), daily(9)]);
    expect(full.triggers).toHaveLength(MAX_TASK_TRIGGERS);
    expect(full.reasons.slice(0, 4)).toEqual([null, null, null, null]);
    expect(full.reasons[4]).toMatch(/already use 48/);
  });

  it("counts only the triggers a schedule adds", () => {
    const many = (minute: number) => triggers(`${minute} 0,1,3,7,8,10,13,15,16,20,22,23 * * *`);
    const fit = fitTaskTriggers([many(1), many(2), many(3), many(4), many(1)]);
    expect(fit.reasons).toEqual([null, null, null, null, null]);
  });
});
