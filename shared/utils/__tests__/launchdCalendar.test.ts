import { describe, expect, it } from "vitest";
import { nextCronOccurrence, parseCron } from "../cron.js";
import {
  MAX_LAUNCHD_INTERVALS_PER_SCHEDULE,
  launchdCalendarFor,
  launchdIntervalKey,
  type LaunchdCalendarInterval,
} from "../launchdCalendar.js";

const DAY_MS = 86_400_000;

function intervals(cron: string, timeZone = "UTC"): readonly LaunchdCalendarInterval[] {
  const result = launchdCalendarFor({ cron, timeZone }, "UTC");
  if (!result.ok) throw new Error(`${cron}: ${result.reason}`);
  return result.intervals;
}

function refusal(cron: string, timeZone = "UTC", machineZone = "UTC"): string {
  const result = launchdCalendarFor({ cron, timeZone }, machineZone);
  if (result.ok) throw new Error(`${cron} was accepted`);
  return result.reason;
}

/** launchd's reading of its calendar, minute by minute: a missing key matches anything. */
function launchdFirings(entries: readonly LaunchdCalendarInterval[], from: number, days: number) {
  const out: number[] = [];
  for (let day = 0; day < days; day++) {
    const start = from + day * DAY_MS;
    const date = new Date(start);
    const minutes = new Set<number>();
    for (const entry of entries) {
      if (entry.Month !== undefined && entry.Month !== date.getUTCMonth() + 1) continue;
      if (entry.Day !== undefined && entry.Day !== date.getUTCDate()) continue;
      if (entry.Weekday !== undefined && entry.Weekday % 7 !== date.getUTCDay()) continue;
      for (let hour = 0; hour < 24; hour++) {
        if (entry.Hour !== undefined && entry.Hour !== hour) continue;
        for (let minute = 0; minute < 60; minute++) {
          if (entry.Minute !== undefined && entry.Minute !== minute) continue;
          minutes.add(hour * 60 + minute);
        }
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

describe("launchdCalendarFor", () => {
  it("writes a daily time as one entry", () => {
    expect(intervals("0 9 * * *")).toEqual([{ Hour: 9, Minute: 0 }]);
  });

  it("leaves out every field that covers its whole range", () => {
    expect(intervals("*/15 * * * *")).toEqual([
      { Minute: 0 },
      { Minute: 15 },
      { Minute: 30 },
      { Minute: 45 },
    ]);
    expect(intervals("30 * * * *")).toEqual([{ Minute: 30 }]);
  });

  it("spells out every minute rather than writing an entry with no keys", () => {
    const every = intervals("* * * * *");
    expect(every).toHaveLength(60);
    expect(every.every((entry) => Object.keys(entry).join() === "Minute")).toBe(true);
  });

  it("writes one entry per combination of restricted fields", () => {
    expect(intervals("0,30 9 * * 1-5")).toHaveLength(10);
    expect(intervals("0 9,17 1 1,7 *")).toEqual([
      { Month: 1, Day: 1, Hour: 9, Minute: 0 },
      { Month: 1, Day: 1, Hour: 17, Minute: 0 },
      { Month: 7, Day: 1, Hour: 9, Minute: 0 },
      { Month: 7, Day: 1, Hour: 17, Minute: 0 },
    ]);
  });

  it("folds Sunday written as 7 onto 0", () => {
    expect(intervals("0 9 * * 7")).toEqual([{ Weekday: 0, Hour: 9, Minute: 0 }]);
  });

  it("writes either-day matching as separate day and weekday entries", () => {
    expect(intervals("0 0 1,15 * FRI")).toEqual([
      { Day: 1, Hour: 0, Minute: 0 },
      { Day: 15, Hour: 0, Minute: 0 },
      { Weekday: 5, Hour: 0, Minute: 0 },
    ]);
  });

  it("reads a restricted day field beside a starred full one as that field alone", () => {
    expect(intervals("0 0 */2 * *")).toHaveLength(16);
    expect(intervals("0 0 * * MON")).toEqual([{ Weekday: 1, Hour: 0, Minute: 0 }]);
    // Neither starts with *, and every day of the month matches: any day fires.
    expect(intervals("0 0 1-31 * MON")).toEqual([{ Hour: 0, Minute: 0 }]);
  });

  it("refuses days that must match both a day of the month and a weekday", () => {
    expect(refusal("0 0 */2 * MON")).toMatch(/both the day of the month and the weekday/);
    expect(refusal("0 0 1-7 * */2")).toMatch(/both the day of the month and the weekday/);
  });

  it("refuses a schedule in a zone other than this Mac's", () => {
    expect(refusal("0 9 * * *", "America/New_York", "Europe/London")).toBe(
      "macOS can only start Daintree on this Mac's time (Europe/London), and this schedule runs on America/New_York time"
    );
    expect(
      launchdCalendarFor({ cron: "0 9 * * *", timeZone: "Europe/London" }, "Europe/London").ok
    ).toBe(true);
  });

  it("refuses a cadence past the per-schedule limit, naming the count", () => {
    // 12 minutes x 9 hours x 5 weekdays.
    expect(refusal("*/5 9-17 * * 1-5")).toBe(
      `macOS would need 540 start times for this cadence, more than the ${MAX_LAUNCHD_INTERVALS_PER_SCHEDULE} one schedule can have`
    );
    expect(intervals("*/15 9-17 * * 1-5")).toHaveLength(180);
  });

  it("passes on the cron error for an expression that doesn't parse", () => {
    expect(refusal("0 25 * * *")).toMatch(/out of range/);
  });

  it.each([
    ["0 9 * * *", 30],
    ["*/15 * * * *", 3],
    ["0,30 9-17 * * 1-5", 30],
    ["0 0 1,15 * FRI", 120],
    ["0 0 */2 * *", 62],
    ["0 0 * * MON", 30],
    ["0 0 1-31 * MON", 14],
    ["15 3 29 2 *", 1500],
    ["0 12 13 * 5", 400],
    ["0 9 * 3-5,11 SAT,SUN", 400],
    ["0 9 31 * *", 400],
  ])("fires launchd at exactly the occurrences of %s", (expression, days) => {
    const from = Date.parse("2027-01-01T00:00:00Z");
    expect(launchdFirings(intervals(expression), from, days)).toEqual(
      cronFirings(expression, from, days)
    );
  });
});

describe("launchdIntervalKey", () => {
  it("is the same for the same entry whatever its key order", () => {
    expect(launchdIntervalKey({ Minute: 0, Hour: 9 })).toBe(
      launchdIntervalKey({ Hour: 9, Minute: 0 })
    );
    expect(launchdIntervalKey({ Hour: 9, Minute: 0 })).not.toBe(
      launchdIntervalKey({ Weekday: 1, Hour: 9, Minute: 0 })
    );
  });
});
