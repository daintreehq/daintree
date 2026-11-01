import { describe, expect, it } from "vitest";
import {
  machineTimeZone,
  nextCronOccurrence,
  nextCronOccurrences,
  parseCron,
  previousCronOccurrence,
  validateTimeZone,
  type ParsedCron,
} from "../cron.js";

function cron(expression: string): ParsedCron {
  const result = parseCron(expression);
  if (!result.ok) throw new Error(`${expression}: ${result.error.message}`);
  return result.cron;
}

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function next(expression: string, timeZone: string, after: string, count = 1): string[] {
  return nextCronOccurrences(cron(expression), timeZone, at(after), count).map((ms) => iso(ms)!);
}

function previous(expression: string, timeZone: string, atIso: string): string | null {
  return iso(previousCronOccurrence(cron(expression), timeZone, at(atIso)));
}

describe("nextCronOccurrence in UTC", () => {
  it("runs daily across a month end", () => {
    expect(next("0 2 * * *", "UTC", "2026-01-31T02:00:00Z", 2)).toEqual([
      "2026-02-01T02:00:00.000Z",
      "2026-02-02T02:00:00.000Z",
    ]);
  });

  it("runs on weekdays only, across a weekend", () => {
    expect(next("0 9 * * MON-FRI", "UTC", "2026-01-30T09:00:00Z", 2)).toEqual([
      "2026-02-02T09:00:00.000Z",
      "2026-02-03T09:00:00.000Z",
    ]);
  });

  it("runs hourly", () => {
    expect(next("0 * * * *", "UTC", "2026-06-01T00:10:00Z", 2)).toEqual([
      "2026-06-01T01:00:00.000Z",
      "2026-06-01T02:00:00.000Z",
    ]);
  });

  it("combines lists, ranges and month names", () => {
    expect(next("10,40 9-10 * APR-JUN MON-FRI", "UTC", "2026-04-01T09:10:00Z", 4)).toEqual([
      "2026-04-01T09:40:00.000Z",
      "2026-04-01T10:10:00.000Z",
      "2026-04-01T10:40:00.000Z",
      "2026-04-02T09:10:00.000Z",
    ]);
  });

  it("steps from the start of a wildcard and of a range", () => {
    expect(next("*/20 9-10 * * *", "UTC", "2026-06-01T09:41:00Z", 3)).toEqual([
      "2026-06-01T10:00:00.000Z",
      "2026-06-01T10:20:00.000Z",
      "2026-06-01T10:40:00.000Z",
    ]);
    expect(next("5-35/15 9 * * *", "UTC", "2026-06-01T09:05:00Z", 3)).toEqual([
      "2026-06-01T09:20:00.000Z",
      "2026-06-01T09:35:00.000Z",
      "2026-06-02T09:05:00.000Z",
    ]);
  });

  it("skips months that don't have the day", () => {
    expect(next("0 0 31 * *", "UTC", "2026-04-01T00:00:00Z", 2)).toEqual([
      "2026-05-31T00:00:00.000Z",
      "2026-07-31T00:00:00.000Z",
    ]);
  });

  it("finds a leap day across a century that isn't a leap year", () => {
    expect(next("0 0 29 2 *", "UTC", "2096-02-29T00:00:00Z")).toEqual(["2104-02-29T00:00:00.000Z"]);
  });

  it("matches either day field when both are restricted", () => {
    // February has no 30th, so only the Mondays fire.
    expect(next("0 0 30 2 MON", "UTC", "2026-02-01T00:00:00Z", 2)).toEqual([
      "2026-02-02T00:00:00.000Z",
      "2026-02-09T00:00:00.000Z",
    ]);
    expect(next("0 0 1 * FRI", "UTC", "2026-05-28T00:00:00Z", 2)).toEqual([
      "2026-05-29T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
    ]);
  });

  it("matches both day fields when one starts with *", () => {
    // Odd days of the month that are also Mondays: 2 February is skipped.
    expect(next("0 0 */2 * MON", "UTC", "2026-02-01T00:00:00Z", 2)).toEqual([
      "2026-02-09T00:00:00.000Z",
      "2026-02-23T00:00:00.000Z",
    ]);
  });

  it("treats 0 and 7 as Sunday, including in ranges", () => {
    const sunday = "2026-06-07T00:00:00.000Z";
    expect(next("0 0 * * 7", "UTC", "2026-06-01T00:00:00Z")).toEqual([sunday]);
    expect(next("0 0 * * 0", "UTC", "2026-06-01T00:00:00Z")).toEqual([sunday]);
    expect(next("0 0 * * 5-7", "UTC", "2026-06-01T00:00:00Z", 3)).toEqual([
      "2026-06-05T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      sunday,
    ]);
  });

  it("accepts lowercase names, duplicates and steps wider than the field", () => {
    expect(next("0,0,30 */60 * jun mon", "UTC", "2026-06-01T00:00:00Z", 2)).toEqual([
      "2026-06-01T00:30:00.000Z",
      "2026-06-08T00:00:00.000Z",
    ]);
  });

  it("returns an instant strictly after the one given", () => {
    const fired = at("2026-06-01T09:00:00Z");
    expect(nextCronOccurrence(cron("0 9 * * *"), "UTC", fired)).toBe(at("2026-06-02T09:00:00Z"));
    expect(nextCronOccurrence(cron("0 9 * * *"), "UTC", fired - 1)).toBe(fired);
  });

  it("agrees with a minute-by-minute scan on ordinary dates", () => {
    const expressions = ["*/7 * * * *", "15 */5 * * 1-5", "0 12 1,15 * *", "30 6 * * SAT,SUN"];
    const zones = [
      { timeZone: "UTC", offsetMinutes: 0 },
      { timeZone: "Asia/Kolkata", offsetMinutes: 330 },
    ];
    const start = at("2026-06-01T00:00:00Z");
    for (const expression of expressions) {
      const parsed = cron(expression);
      for (const { timeZone, offsetMinutes } of zones) {
        const scanned: number[] = [];
        for (
          let t = start + 60_000;
          scanned.length < 12 && t < start + 40 * 86_400_000;
          t += 60_000
        ) {
          const wall = new Date(t + offsetMinutes * 60_000);
          const dayOfMonth = wall.getUTCDate();
          const dayOfWeek = wall.getUTCDay();
          const byMonthDay = parsed.daysOfMonth[dayOfMonth] === true;
          const byWeekday = parsed.daysOfWeek[dayOfWeek] === true;
          const dayOk =
            parsed.dayOfMonthStarred || parsed.dayOfWeekStarred
              ? byMonthDay && byWeekday
              : byMonthDay || byWeekday;
          if (
            parsed.minutes.includes(wall.getUTCMinutes()) &&
            parsed.hours.includes(wall.getUTCHours()) &&
            parsed.months[wall.getUTCMonth() + 1] === true &&
            dayOk
          ) {
            scanned.push(t);
          }
        }
        expect(nextCronOccurrences(parsed, timeZone, start, scanned.length)).toEqual(scanned);
      }
    }
  });
});

describe("nextCronOccurrence across daylight saving", () => {
  it("fires a minute skipped by spring-forward when the clocks jump (New York)", () => {
    expect(next("30 2 * * *", "America/New_York", "2026-03-08T06:59:00Z", 2)).toEqual([
      "2026-03-08T07:00:00.000Z",
      "2026-03-09T06:30:00.000Z",
    ]);
  });

  it("coalesces every minute skipped by spring-forward into one firing", () => {
    expect(next("*/15 * * * *", "America/New_York", "2026-03-08T06:45:00Z", 3)).toEqual([
      "2026-03-08T07:00:00.000Z",
      "2026-03-08T07:15:00.000Z",
      "2026-03-08T07:30:00.000Z",
    ]);
  });

  it("fires a repeated fall-back minute once, on its first showing (New York)", () => {
    expect(next("30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z", 2)).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
  });

  it("doesn't fire again during the second showing of a repeated hour", () => {
    // 06:10Z is 01:10 EST, after the EDT 01:30 already fired.
    expect(next("30 1 * * *", "America/New_York", "2026-11-01T06:10:00Z")).toEqual([
      "2026-11-02T06:30:00.000Z",
    ]);
  });

  it("runs an hourly job once through the repeated hour", () => {
    expect(next("0 * * * *", "America/New_York", "2026-11-01T04:00:00Z", 3)).toEqual([
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T08:00:00.000Z",
    ]);
  });

  it("handles London's spring-forward and fall-back", () => {
    expect(next("30 1 * * *", "Europe/London", "2026-03-29T00:00:00Z")).toEqual([
      "2026-03-29T01:00:00.000Z",
    ]);
    expect(next("30 1 * * *", "Europe/London", "2026-10-24T23:00:00Z", 2)).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
    ]);
  });

  it("handles a southern-hemisphere zone (Sydney)", () => {
    expect(next("30 2 * * *", "Australia/Sydney", "2026-10-03T15:59:00Z")).toEqual([
      "2026-10-03T16:00:00.000Z",
    ]);
    expect(next("30 2 * * *", "Australia/Sydney", "2026-04-04T14:00:00Z", 2)).toEqual([
      "2026-04-04T15:30:00.000Z",
      "2026-04-05T16:30:00.000Z",
    ]);
  });

  it("handles a half-hour daylight-saving shift (Lord Howe)", () => {
    expect(next("15 2 * * *", "Australia/Lord_Howe", "2026-10-03T15:29:00Z")).toEqual([
      "2026-10-03T15:30:00.000Z",
    ]);
    expect(next("45 1 * * *", "Australia/Lord_Howe", "2026-04-04T14:00:00Z", 2)).toEqual([
      "2026-04-04T14:45:00.000Z",
      "2026-04-05T15:15:00.000Z",
    ]);
  });

  it("fires a date the zone skipped entirely when the clocks jump (Apia, 2011)", () => {
    expect(next("0 0 30 12 *", "Pacific/Apia", "2011-12-29T10:00:00Z")).toEqual([
      "2011-12-30T10:00:00.000Z",
    ]);
  });
});

describe("nextCronOccurrence in a named zone", () => {
  it("computes in the schedule's zone, not the machine's", () => {
    const timeZone = machineTimeZone() === "Asia/Kathmandu" ? "America/Denver" : "Asia/Kathmandu";
    const expected =
      timeZone === "Asia/Kathmandu" ? "2026-06-01T03:15:00.000Z" : "2026-06-01T15:00:00.000Z";
    expect(next("0 9 * * *", timeZone, "2026-06-01T00:00:00Z")).toEqual([expected]);
  });
});

describe("previousCronOccurrence", () => {
  it("includes an occurrence exactly at the time given", () => {
    expect(previous("0 9 * * *", "UTC", "2026-06-01T09:00:00Z")).toBe("2026-06-01T09:00:00.000Z");
    expect(previous("0 9 * * *", "UTC", "2026-06-01T08:59:59.999Z")).toBe(
      "2026-05-31T09:00:00.000Z"
    );
  });

  it("finds the first showing of a repeated minute from its second pass", () => {
    // 06:10Z shows 01:10 EST, but 01:45 EDT (05:45Z) has already happened.
    expect(previous("45 1 * * *", "America/New_York", "2026-11-01T06:10:00Z")).toBe(
      "2026-11-01T05:45:00.000Z"
    );
    expect(previous("45 1 * * *", "America/New_York", "2026-11-01T05:30:00Z")).toBe(
      "2026-10-31T05:45:00.000Z"
    );
  });

  it("finds a skipped minute at the jump", () => {
    expect(previous("30 2 * * *", "America/New_York", "2026-03-08T07:00:00Z")).toBe(
      "2026-03-08T07:00:00.000Z"
    );
    expect(previous("30 2 * * *", "America/New_York", "2026-03-08T06:59:59Z")).toBe(
      "2026-03-07T07:30:00.000Z"
    );
  });

  it("is the inverse of next for successive occurrences", () => {
    const parsed = cron("*/20 8-18 * * MON-FRI");
    const times = nextCronOccurrences(parsed, "Europe/London", at("2026-10-23T12:00:00Z"), 60);
    for (let index = 1; index < times.length; index++) {
      expect(previousCronOccurrence(parsed, "Europe/London", times[index]! - 1)).toBe(
        times[index - 1]
      );
    }
  });
});

describe("nextCronOccurrences", () => {
  it("returns strictly increasing instants that match repeated single lookups", () => {
    const parsed = cron("*/15 * * * *");
    const times = nextCronOccurrences(parsed, "America/New_York", at("2026-11-01T04:30:00Z"), 16);
    expect(times).toHaveLength(16);
    let cursor = at("2026-11-01T04:30:00Z");
    for (const time of times) {
      expect(time).toBeGreaterThan(cursor);
      expect(nextCronOccurrence(parsed, "America/New_York", cursor)).toBe(time);
      cursor = time;
    }
  });

  it("returns nothing for a count of zero and refuses a bad count or time", () => {
    const parsed = cron("0 9 * * *");
    expect(nextCronOccurrences(parsed, "UTC", 0, 0)).toEqual([]);
    expect(() => nextCronOccurrences(parsed, "UTC", 0, -1)).toThrow(RangeError);
    expect(() => nextCronOccurrence(parsed, "UTC", Number.NaN)).toThrow(RangeError);
  });
});

describe("parseCron validation", () => {
  function error(expression: string) {
    const result = parseCron(expression);
    if (result.ok) throw new Error(`${expression} parsed`);
    return result.error;
  }

  it("asks for an expression when there is none", () => {
    expect(error("   ")).toMatchObject({ field: null });
  });

  it("names the field count when it isn't five", () => {
    expect(error("* * * *").message).toMatch(/five fields.*not 4/);
    expect(error("0 * * * * *").message).toMatch(/five fields.*not 6/);
  });

  it("refuses macros by name", () => {
    const { field, message } = error("@daily");
    expect(field).toBeNull();
    expect(message).toMatch(/@daily isn't supported/);
  });

  it("names the field and limits of an out-of-range value", () => {
    expect(error("60 * * * *")).toMatchObject({ field: "minute" });
    expect(error("60 * * * *").message).toMatch(/60.*0-59/);
    expect(error("* 24 * * *")).toMatchObject({ field: "hour" });
    expect(error("* * 0 * *")).toMatchObject({ field: "dayOfMonth" });
    expect(error("* * * 13 *").message).toMatch(/13.*1-12/);
    expect(error("* * * * 8")).toMatchObject({ field: "dayOfWeek" });
  });

  it("explains backwards and wrap-around ranges", () => {
    expect(error("20-10 * * * *").message).toMatch(/20-10 runs backwards/);
    expect(error("0 0 * * FRI-MON")).toMatchObject({ field: "dayOfWeek" });
  });

  it("explains bad steps", () => {
    expect(error("*/0 * * * *").message).toMatch(/step must be 1 or more/);
    expect(error("*/x * * * *").message).toMatch(/step "x"/);
    expect(error("5/15 * * * *").message).toMatch(/needs a range.*5-59\/15/);
    expect(error("1/2/3 * * * *")).toMatchObject({ field: "minute" });
  });

  it("names unknown names and empty list items", () => {
    expect(error("0 0 * FOO *").message).toMatch(/"FOO".*JAN-DEC/);
    expect(error("0 0 * * MONDAY").message).toMatch(/"MONDAY".*SUN-SAT/);
    expect(error("0 0 1,,2 * *").message).toMatch(/empty list item/);
    expect(error("a * * * *").message).toMatch(/"a" isn't a number/);
  });

  it("names Quartz and other non-standard syntax", () => {
    expect(error("0 0 L * *")).toMatchObject({ field: "dayOfMonth" });
    expect(error("0 0 L * *").message).toMatch(/"L"/);
    expect(error("0 0 ? * MON").message).toMatch(/"\?"/);
    expect(error("0 0 * * 5#3").message).toMatch(/"#"/);
    expect(error("0 0 15W * *").message).toMatch(/"W"/);
    expect(error("0 0 * * 5L").message).toMatch(/"L"/);
  });

  it("refuses an expression that can never fire", () => {
    expect(error("0 0 30 2 *")).toMatchObject({ field: "dayOfMonth" });
    expect(error("0 0 30 2 *").message).toMatch(/never runs: February has at most 29 days/);
    expect(error("0 0 31 4,6,9,11 *").message).toMatch(/never runs/);
    expect(error("0 0 31 2 */2").message).toMatch(/never runs/);
  });

  it("accepts expressions that fire only rarely", () => {
    expect(parseCron("0 0 29 2 *").ok).toBe(true);
    expect(parseCron("0 0 31 2,3 *").ok).toBe(true);
    expect(parseCron("0 0 31 2 MON").ok).toBe(true);
  });

  it("refuses an expression split over lines or too long to be cron", () => {
    expect(error("0 0\n* * *").message).toMatch(/one line/);
    expect(error(`${"1,".repeat(200)}2 * * * *`)).toMatchObject({ field: null });
  });

  it("ignores surrounding whitespace and accepts tabs between fields", () => {
    expect(parseCron("  0\t9 * * *  ").ok).toBe(true);
  });
});

describe("validateTimeZone", () => {
  it("resolves a name written in any case", () => {
    expect(validateTimeZone("america/new_york")).toEqual({
      ok: true,
      timeZone: "America/New_York",
    });
    expect(validateTimeZone("UTC").ok).toBe(true);
  });

  it("refuses unknown zones, blanks and numeric offsets", () => {
    const unknown = validateTimeZone("Mars/Olympus_Mons");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toMatch(/Mars\/Olympus_Mons/);
    expect(validateTimeZone(" ").ok).toBe(false);
    const offset = validateTimeZone("+05:00");
    expect(offset.ok).toBe(false);
    if (!offset.ok) expect(offset.message).toMatch(/named time zone/);
  });

  it("names the machine's zone as one it accepts", () => {
    expect(validateTimeZone(machineTimeZone()).ok).toBe(true);
  });
});
