import { describe, expect, it } from "vitest";
import { describeCron } from "../cronDescription.js";

// en-US so the clock reads "9:00 AM" whatever the machine's locale. ICU puts a
// narrow no-break space before AM/PM; the assertions spell it as a plain space.
const words = (expression: string) =>
  describeCron(expression, "en-US")?.replace(/\u202f/g, " ") ?? null;

describe("describeCron", () => {
  it("reads a daily time", () => {
    expect(words("0 9 * * *")).toBe("Every day at 9:00 AM");
    expect(words("30 14 * * *")).toBe("Every day at 2:30 PM");
  });

  it("reads weekdays and weekends the same however they are written", () => {
    expect(words("0 9 * * 1-5")).toBe("Weekdays at 9:00 AM");
    expect(words("0 9 * * MON,TUE,WED,THU,FRI")).toBe("Weekdays at 9:00 AM");
    expect(words("0 10 * * 0,6")).toBe("Weekends at 10:00 AM");
    expect(words("0 10 * * SAT,7")).toBe("Weekends at 10:00 AM");
  });

  it("names chosen weekdays Monday first", () => {
    expect(words("0 18 * * 5,1")).toBe("Mondays and Fridays at 6:00 PM");
    expect(words("0 18 * * 0,3")).toBe("Wednesdays and Sundays at 6:00 PM");
  });

  it("reads days of the month with ordinals", () => {
    expect(words("0 10 1 * *")).toBe("On the 1st of the month at 10:00 AM");
    expect(words("0 10 2,13,22 * *")).toBe("On the 2nd, 13th and 22nd of the month at 10:00 AM");
  });

  it("reads a day of month and a weekday as either, the way cron fires them", () => {
    expect(words("0 0 1 * FRI")).toBe("On the 1st of the month and on Fridays at 12:00 AM");
  });

  it("reads intervals through the day", () => {
    expect(words("* * * * *")).toBe("Every minute");
    expect(words("*/15 * * * *")).toBe("Every 15 minutes");
    expect(words("0 * * * *")).toBe("Every hour");
    expect(words("30 * * * *")).toBe("Every hour at :30");
    expect(words("0 */6 * * *")).toBe("Every 6 hours");
    expect(words("*/30 * * * 1-5")).toBe("Every 30 minutes, on weekdays");
  });

  it("lists a few times in a day", () => {
    expect(words("0 9,17 * * *")).toBe("Every day at 9:00 AM and 5:00 PM");
  });

  it("names a few months", () => {
    expect(words("0 9 1 1,7 *")).toBe("On the 1st of the month at 9:00 AM in January and July");
  });

  it("answers null when there is no short honest reading", () => {
    // An interval offset from the hour is not "every 15 minutes".
    expect(words("5-59/15 * * * *")).toBeNull();
    // Steps that don't divide the hour or the day leave an uneven gap at the wrap.
    expect(words("*/40 * * * *")).toBeNull();
    expect(words("0 */5 * * *")).toBeNull();
    // Both day fields restricted with one starred fire only where both match.
    expect(words("15 3 */2 * 1-5")).toBeNull();
    expect(words("0 9 1-10 * *")).toBeNull();
    expect(words("0 9 * 1-6 *")).toBeNull();
    expect(words("0 0-23/2 * * *")).toBe("Every 2 hours");
    expect(words("0,30 9-17 * * *")).toBeNull();
  });

  it("answers null for an expression cron refuses", () => {
    expect(words("61 9 * * *")).toBeNull();
    expect(words("")).toBeNull();
  });
});
