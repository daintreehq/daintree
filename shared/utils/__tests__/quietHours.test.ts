import { describe, expect, it } from "vitest";
import {
  formatTimeOfDay,
  isInQuietHoursWindow,
  isScheduledQuietNow,
  isWeekdayActive,
  nextOccurrenceTimestamp,
} from "../quietHours.js";

describe("isInQuietHoursWindow", () => {
  it("same-day window — inclusive start, exclusive end", () => {
    expect(isInQuietHoursWindow(9 * 60, 17 * 60, 9 * 60)).toBe(true);
    expect(isInQuietHoursWindow(9 * 60, 17 * 60, 12 * 60)).toBe(true);
    expect(isInQuietHoursWindow(9 * 60, 17 * 60, 17 * 60)).toBe(false);
    expect(isInQuietHoursWindow(9 * 60, 17 * 60, 8 * 60 + 59)).toBe(false);
  });

  it("midnight wraparound — 22:00 to 06:00", () => {
    expect(isInQuietHoursWindow(22 * 60, 6 * 60, 22 * 60)).toBe(true);
    expect(isInQuietHoursWindow(22 * 60, 6 * 60, 23 * 60)).toBe(true);
    expect(isInQuietHoursWindow(22 * 60, 6 * 60, 0)).toBe(true);
    expect(isInQuietHoursWindow(22 * 60, 6 * 60, 5 * 60 + 59)).toBe(true);
    expect(isInQuietHoursWindow(22 * 60, 6 * 60, 6 * 60)).toBe(false);
    expect(isInQuietHoursWindow(22 * 60, 6 * 60, 12 * 60)).toBe(false);
    expect(isInQuietHoursWindow(22 * 60, 6 * 60, 21 * 60 + 59)).toBe(false);
  });

  it("start === end disables the window", () => {
    expect(isInQuietHoursWindow(12 * 60, 12 * 60, 12 * 60)).toBe(false);
    expect(isInQuietHoursWindow(0, 0, 0)).toBe(false);
  });

  it("rejects out-of-range inputs safely", () => {
    expect(isInQuietHoursWindow(-1, 100, 50)).toBe(false);
    expect(isInQuietHoursWindow(100, 1500, 50)).toBe(false);
    expect(isInQuietHoursWindow(Number.NaN, 100, 50)).toBe(false);
    expect(isInQuietHoursWindow(100, 200, -5)).toBe(false);
    expect(isInQuietHoursWindow(100, 200, 1500)).toBe(false);
  });

  it("midnight-boundary window — 00:00 to 01:00", () => {
    expect(isInQuietHoursWindow(0, 60, 0)).toBe(true);
    expect(isInQuietHoursWindow(0, 60, 30)).toBe(true);
    expect(isInQuietHoursWindow(0, 60, 60)).toBe(false);
  });
});

describe("isWeekdayActive", () => {
  it("empty array means every day", () => {
    expect(isWeekdayActive([], 0)).toBe(true);
    expect(isWeekdayActive([], 3)).toBe(true);
    expect(isWeekdayActive(undefined, 6)).toBe(true);
  });

  it("includes selected days", () => {
    expect(isWeekdayActive([1, 2, 3, 4, 5], 1)).toBe(true);
    expect(isWeekdayActive([1, 2, 3, 4, 5], 0)).toBe(false);
    expect(isWeekdayActive([1, 2, 3, 4, 5], 6)).toBe(false);
  });
});

describe("isScheduledQuietNow", () => {
  it("returns false when schedule is disabled", () => {
    const now = new Date(2024, 0, 1, 23, 0); // Monday 23:00
    expect(
      isScheduledQuietNow(
        {
          quietHoursEnabled: false,
          quietHoursStartMin: 22 * 60,
          quietHoursEndMin: 6 * 60,
          quietHoursWeekdays: [],
        },
        now
      )
    ).toBe(false);
  });

  it("returns true within a wraparound window on an active day", () => {
    const now = new Date(2024, 0, 1, 23, 0); // Monday 23:00
    expect(
      isScheduledQuietNow(
        {
          quietHoursEnabled: true,
          quietHoursStartMin: 22 * 60,
          quietHoursEndMin: 6 * 60,
          quietHoursWeekdays: [],
        },
        now
      )
    ).toBe(true);
  });

  it("wraparound window — early morning counts the previous day's schedule", () => {
    const mondayMorning = new Date(2024, 0, 1, 2, 0); // Monday 02:00 (Sun->Mon)
    // Schedule runs Sunday 22:00 -> next morning. Sunday = 0.
    expect(
      isScheduledQuietNow(
        {
          quietHoursEnabled: true,
          quietHoursStartMin: 22 * 60,
          quietHoursEndMin: 6 * 60,
          quietHoursWeekdays: [0], // Sundays only
        },
        mondayMorning
      )
    ).toBe(true);
  });

  it("wraparound window — Monday morning does not fire if Mondays are not selected", () => {
    const mondayMorning = new Date(2024, 0, 1, 2, 0);
    expect(
      isScheduledQuietNow(
        {
          quietHoursEnabled: true,
          quietHoursStartMin: 22 * 60,
          quietHoursEndMin: 6 * 60,
          quietHoursWeekdays: [1], // Mondays only
        },
        mondayMorning
      )
    ).toBe(false);
  });

  it("returns false outside the window", () => {
    const now = new Date(2024, 0, 1, 14, 0); // 14:00
    expect(
      isScheduledQuietNow(
        {
          quietHoursEnabled: true,
          quietHoursStartMin: 22 * 60,
          quietHoursEndMin: 6 * 60,
          quietHoursWeekdays: [],
        },
        now
      )
    ).toBe(false);
  });

  it("handles missing fields gracefully", () => {
    expect(isScheduledQuietNow(undefined)).toBe(false);
    expect(isScheduledQuietNow({ quietHoursEnabled: true })).toBe(false);
  });
});

describe("nextOccurrenceTimestamp", () => {
  it("returns today's occurrence if in the future", () => {
    const now = new Date(2024, 0, 1, 6, 0);
    const next = nextOccurrenceTimestamp(8 * 60, now);
    expect(new Date(next).getHours()).toBe(8);
    expect(new Date(next).getDate()).toBe(1);
  });

  it("returns tomorrow's occurrence if already past the target", () => {
    const now = new Date(2024, 0, 1, 10, 0);
    const next = nextOccurrenceTimestamp(8 * 60, now);
    expect(new Date(next).getHours()).toBe(8);
    expect(new Date(next).getDate()).toBe(2);
  });

  it("returns tomorrow when target equals now (strictly future)", () => {
    const now = new Date(2024, 0, 1, 8, 0, 0, 0);
    const next = nextOccurrenceTimestamp(8 * 60, now);
    expect(new Date(next).getDate()).toBe(2);
    expect(new Date(next).getHours()).toBe(8);
  });
});

describe("formatTimeOfDay", () => {
  it("zero-pads hour and minute", () => {
    expect(formatTimeOfDay(0)).toBe("00:00");
    expect(formatTimeOfDay(9 * 60 + 5)).toBe("09:05");
    expect(formatTimeOfDay(22 * 60)).toBe("22:00");
    expect(formatTimeOfDay(23 * 60 + 59)).toBe("23:59");
  });

  it("clamps out-of-range inputs", () => {
    expect(formatTimeOfDay(-10)).toBe("00:00");
    expect(formatTimeOfDay(2000)).toBe("23:59");
  });
});
