import { describe, expect, it } from "vitest";

type TemporalBucket = "today" | "this-week" | "older";

function getTemporalBucket(
  timestamp: number,
  todayStart: number,
  weekStart: number
): TemporalBucket {
  if (timestamp >= todayStart) return "today";
  if (timestamp >= weekStart) return "this-week";
  return "older";
}

function computeBoundaries(now: Date) {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - mondayOffset
  ).getTime();
  return { todayStart, weekStart };
}

describe("temporal bucketing", () => {
  it("classifies timestamps from today into 'today'", () => {
    const now = new Date(2026, 3, 1, 14, 30); // Wed Apr 1 2026, 14:30
    const { todayStart, weekStart } = computeBoundaries(now);

    expect(getTemporalBucket(now.getTime(), todayStart, weekStart)).toBe("today");
    expect(getTemporalBucket(todayStart, todayStart, weekStart)).toBe("today");
    expect(getTemporalBucket(todayStart + 1, todayStart, weekStart)).toBe("today");
  });

  it("classifies timestamps from earlier this week into 'this-week'", () => {
    const now = new Date(2026, 3, 1, 14, 30); // Wed Apr 1 2026
    const { todayStart, weekStart } = computeBoundaries(now);

    // Monday of the same week
    const monday = new Date(2026, 2, 30, 10, 0).getTime();
    expect(getTemporalBucket(monday, todayStart, weekStart)).toBe("this-week");

    // Just before today started (yesterday 23:59)
    expect(getTemporalBucket(todayStart - 1, todayStart, weekStart)).toBe("this-week");
  });

  it("classifies timestamps from before this week into 'older'", () => {
    const now = new Date(2026, 3, 1, 14, 30); // Wed Apr 1 2026
    const { todayStart, weekStart } = computeBoundaries(now);

    // Last Sunday (before Monday)
    const lastSunday = new Date(2026, 2, 29, 23, 59).getTime();
    expect(getTemporalBucket(lastSunday, todayStart, weekStart)).toBe("older");

    expect(getTemporalBucket(0, todayStart, weekStart)).toBe("older");
  });

  it("handles Monday correctly (week start = today)", () => {
    const now = new Date(2026, 2, 30, 10, 0); // Mon Mar 30 2026
    const { todayStart, weekStart } = computeBoundaries(now);

    // Monday start should equal today start
    expect(weekStart).toBe(todayStart);

    // Something from today is 'today'
    expect(getTemporalBucket(now.getTime(), todayStart, weekStart)).toBe("today");

    // Sunday is 'older' (previous week)
    const sunday = new Date(2026, 2, 29, 23, 0).getTime();
    expect(getTemporalBucket(sunday, todayStart, weekStart)).toBe("older");
  });

  it("handles Sunday correctly (week start = 6 days ago)", () => {
    const now = new Date(2026, 3, 5, 10, 0); // Sun Apr 5 2026
    const { todayStart, weekStart } = computeBoundaries(now);

    // Monday of the same week (Mar 30)
    const monday = new Date(2026, 2, 30, 10, 0).getTime();
    expect(getTemporalBucket(monday, todayStart, weekStart)).toBe("this-week");

    // Previous Sunday (Mar 29) should be 'older'
    const prevSunday = new Date(2026, 2, 29, 23, 59).getTime();
    expect(getTemporalBucket(prevSunday, todayStart, weekStart)).toBe("older");
  });

  it("classifies exact boundary timestamps correctly (>= not >)", () => {
    const now = new Date(2026, 3, 2, 10, 0); // Thu Apr 2 2026
    const { todayStart, weekStart } = computeBoundaries(now);

    // Exact todayStart boundary → today
    expect(getTemporalBucket(todayStart, todayStart, weekStart)).toBe("today");
    // One ms before todayStart → this-week
    expect(getTemporalBucket(todayStart - 1, todayStart, weekStart)).toBe("this-week");

    // Exact weekStart boundary → this-week
    expect(getTemporalBucket(weekStart, todayStart, weekStart)).toBe("this-week");
    // One ms before weekStart → older
    expect(getTemporalBucket(weekStart - 1, todayStart, weekStart)).toBe("older");
  });

  it("classifies zero lastOpened as 'older'", () => {
    const now = new Date(2026, 3, 1, 14, 30);
    const { todayStart, weekStart } = computeBoundaries(now);
    expect(getTemporalBucket(0, todayStart, weekStart)).toBe("older");
  });
});
