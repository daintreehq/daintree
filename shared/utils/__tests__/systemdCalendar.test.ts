import { describe, expect, it } from "vitest";
import { nextCronOccurrence, parseCron } from "../cron.js";
import { systemdCalendarFor } from "../systemdCalendar.js";

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function specs(cron: string, timeZone = "UTC"): readonly string[] {
  const result = systemdCalendarFor({ cron, timeZone }, "UTC");
  if (!result.ok) throw new Error(`${cron}: ${result.reason}`);
  return result.specs;
}

function refusal(cron: string, timeZone = "UTC", machineZone = "UTC"): string {
  const result = systemdCalendarFor({ cron, timeZone }, machineZone);
  if (result.ok) throw new Error(`${cron} was accepted`);
  return result.reason;
}

/** One component as systemd reads it: `*` matches anything, else a list of values. */
function component(text: string): (value: number) => boolean {
  if (text === "*") return () => true;
  const values = new Set(text.split(",").map((part) => Number(part)));
  return (value) => values.has(value);
}

/**
 * systemd's reading of the lines written here, minute by minute: an optional
 * weekday list, then `*-MM-DD HH:MM:SS`, every part of one line ANDed and the
 * lines ORed.
 */
function systemdFirings(lines: readonly string[], from: number, days: number): number[] {
  const parsed = lines.map((line) => {
    const match = /^(?:([A-Za-z,]+) )?\*-([^-]+)-(\S+) ([^:]+):([^:]+):00$/.exec(line);
    if (!match) throw new Error(`unexpected OnCalendar line: ${line}`);
    const weekdays = match[1]?.split(",").map((name) => WEEKDAYS.indexOf(name));
    if (weekdays?.includes(-1)) throw new Error(`unexpected weekday in ${line}`);
    return {
      weekday: weekdays ? (day: number) => weekdays.includes(day) : () => true,
      month: component(match[2]!),
      day: component(match[3]!),
      hour: component(match[4]!),
      minute: component(match[5]!),
    };
  });
  const out: number[] = [];
  for (let day = 0; day < days; day++) {
    const start = from + day * DAY_MS;
    const date = new Date(start);
    for (let minute = 0; minute < 24 * 60; minute++) {
      const fires = parsed.some(
        (line) =>
          line.weekday(date.getUTCDay()) &&
          line.month(date.getUTCMonth() + 1) &&
          line.day(date.getUTCDate()) &&
          line.hour(Math.floor(minute / 60)) &&
          line.minute(minute % 60)
      );
      if (fires) out.push(start + minute * 60_000);
    }
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

describe("systemdCalendarFor", () => {
  it("writes a daily time as one line, every whole-range field as *", () => {
    expect(specs("0 9 * * *")).toEqual(["*-*-* 09:00:00"]);
    expect(specs("* * * * *")).toEqual(["*-*-* *:*:00"]);
  });

  it("writes restricted fields as plain lists", () => {
    expect(specs("*/15 * * * *")).toEqual(["*-*-* *:00,15,30,45:00"]);
    expect(specs("0,30 9-11 1 1,7 *")).toEqual(["*-01,07-01 09,10,11:00,30:00"]);
  });

  it("names weekdays, folding Sunday written as 7 onto Sun", () => {
    expect(specs("0 9 * * 1-5")).toEqual(["Mon,Tue,Wed,Thu,Fri *-*-* 09:00:00"]);
    expect(specs("0 9 * * 7")).toEqual(["Sun *-*-* 09:00:00"]);
  });

  it("writes either-day matching as a date line and a weekday line", () => {
    expect(specs("0 0 1,15 * FRI")).toEqual(["*-*-01,15 00:00:00", "Fri *-*-* 00:00:00"]);
    // Neither starts with *, and every day of the month matches: any day fires.
    expect(specs("0 0 1-31 * MON")).toEqual(["*-*-* 00:00:00"]);
  });

  it("writes days that must match both fields as one line with both", () => {
    expect(specs("0 0 */2 * MON")).toEqual([
      "Mon *-*-01,03,05,07,09,11,13,15,17,19,21,23,25,27,29,31 00:00:00",
    ]);
    expect(specs("0 0 1-7 * */2")).toEqual(["Sun,Tue,Thu,Sat *-*-01,02,03,04,05,06,07 00:00:00"]);
  });

  it("reads a restricted day field beside a starred full one as that field alone", () => {
    expect(specs("0 0 * * MON")).toEqual(["Mon *-*-* 00:00:00"]);
    expect(specs("0 0 1 * *")).toEqual(["*-*-01 00:00:00"]);
  });

  it("leaves out days no chosen month has, and a date line left with none", () => {
    expect(specs("0 9 31 2 MON")).toEqual(["Mon *-02-* 09:00:00"]);
    expect(specs("0 9 30,31 2,4 MON")).toEqual(["*-02,04-30 09:00:00", "Mon *-02,04-* 09:00:00"]);
  });

  it("refuses a schedule in a zone other than this computer's", () => {
    expect(refusal("0 9 * * *", "America/New_York", "Europe/London")).toBe(
      "systemd can only start Daintree on this computer's time (Europe/London), and this schedule runs on America/New_York time"
    );
    expect(
      systemdCalendarFor({ cron: "0 9 * * *", timeZone: "US/Eastern" }, "America/New_York").ok
    ).toBe(true);
    expect(refusal("0 9 * * *", "Not/AZone")).toMatch(/isn't a time zone/);
  });

  it("passes on the cron error for an expression that doesn't parse", () => {
    expect(refusal("0 25 * * *")).toMatch(/out of range/);
  });

  it.each([
    ["0 9 * * *", 30],
    ["*/15 * * * *", 3],
    ["*/5 9-17 * * 1-5", 14],
    ["0,30 9-17 * * 1-5", 30],
    ["0 0 1,15 * FRI", 120],
    ["0 0 */2 * *", 62],
    ["0 0 */2 * MON", 120],
    ["0 0 1-7 * */2", 120],
    ["0 0 * * MON", 30],
    ["0 0 1-31 * MON", 14],
    ["15 3 29 2 *", 1500],
    ["0 12 13 * 5", 400],
    ["0 12 13 * */5", 800],
    ["0 9 * 3-5,11 SAT,SUN", 400],
    ["0 9 31 * *", 400],
    ["* * * * *", 2],
    ["0 9 31 2 MON", 800],
    ["0 9 30,31 2,4 MON", 800],
  ])("fires systemd at exactly the occurrences of %s", (expression, days) => {
    const from = Date.parse("2027-01-01T00:00:00Z");
    expect(systemdFirings(specs(expression), from, days)).toEqual(
      cronFirings(expression, from, days)
    );
  });
});
