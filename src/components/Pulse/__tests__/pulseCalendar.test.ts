import { describe, it, expect } from "vitest";
import type { HeatCell } from "@shared/types";
import {
  DAYS_PER_WEEK,
  buildPulseCalendar,
  moveInCalendar,
  parseLocalDay,
  weekdayIndex,
} from "../pulseCalendar";

const LEVELS: readonly HeatCell["level"][] = [0, 1, 2, 3, 4];

function isoDay(day: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** `length` consecutive days ending on `end`, with a varied, deterministic count. */
function range(end: Date, length: number): HeatCell[] {
  return Array.from({ length }, (_, i) => {
    const day = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (length - 1 - i));
    const level = LEVELS[(i * 7) % 5]!;
    return { date: isoDay(day), count: level, level };
  });
}

const END = new Date(2026, 8, 24); // a Thursday

describe("parseLocalDay", () => {
  it("reads a YYYY-MM-DD cell date as that calendar day in local time", () => {
    // `new Date("2026-05-13")` is UTC midnight — the 12th anywhere west of
    // Greenwich. The tooltip must name the day the service bucketed.
    const day = parseLocalDay("2026-05-13")!;
    expect([day.getFullYear(), day.getMonth(), day.getDate()]).toEqual([2026, 4, 13]);
    expect(isoDay(day)).toBe("2026-05-13");
  });

  it("rejects malformed dates instead of inventing one", () => {
    expect(parseLocalDay("not-a-date")).toBeNull();
    expect(parseLocalDay("2026-5-3")).toBeNull();
  });
});

describe("buildPulseCalendar — week-column geometry", () => {
  for (const length of [5, 60, 120, 180]) {
    it(`places every one of ${length} days once, on its weekday row`, () => {
      const cells = range(END, length);
      const calendar = buildPulseCalendar(cells);
      expect(calendar.days).toHaveLength(length);
      for (const cell of cells) {
        const pos = calendar.positions.get(cell.date)!;
        expect(pos.row).toBe(weekdayIndex(parseLocalDay(cell.date)!));
        expect(calendar.weeks[pos.col]![pos.row]).toBe(cell);
      }
      for (const week of calendar.weeks) expect(week).toHaveLength(DAYS_PER_WEEK);
    });
  }

  it("keeps a weekend together as the bottom two rows of one week column", () => {
    const calendar = buildPulseCalendar(range(END, 60));
    const saturdays = calendar.days.filter((c) => parseLocalDay(c.date)!.getDay() === 6);
    expect(saturdays.length).toBeGreaterThan(0);
    for (const saturday of saturdays) {
      const d = parseLocalDay(saturday.date)!;
      const sunday = isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
      const sat = calendar.positions.get(saturday.date)!;
      expect(sat.row).toBe(DAYS_PER_WEEK - 2);
      const sun = calendar.positions.get(sunday);
      if (sun) expect(sun).toEqual({ row: DAYS_PER_WEEK - 1, col: sat.col });
    }
  });

  it("reads chronologically down each column, then across", () => {
    const calendar = buildPulseCalendar(range(END, 60));
    const inGridOrder = calendar.weeks.flat().filter((c): c is HeatCell => c !== null);
    expect(inGridOrder.map((c) => c.date)).toEqual(calendar.days.map((c) => c.date));
  });

  it("fits the widest range inside a single short row of weeks", () => {
    // 180 days can straddle at most 27 week columns; the strip layout needed 60.
    expect(buildPulseCalendar(range(END, 180)).weeks.length).toBeLessThanOrEqual(27);
  });

  it("puts the latest day in the last column", () => {
    const calendar = buildPulseCalendar(range(END, 120));
    const latest = calendar.days[calendar.days.length - 1]!;
    expect(calendar.positions.get(latest.date)!.col).toBe(calendar.weeks.length - 1);
  });

  it("is order-independent", () => {
    const cells = range(END, 60);
    const shuffled = [...cells].reverse();
    expect(buildPulseCalendar(shuffled).days).toEqual(buildPulseCalendar(cells).days);
  });

  it("labels each month once, where its first real day falls, and never crowds two labels", () => {
    const calendar = buildPulseCalendar(range(END, 180));
    const labels = calendar.monthLabels;
    expect(labels.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < labels.length; i += 1) {
      expect(labels[i]!.col - labels[i - 1]!.col).toBeGreaterThanOrEqual(3);
      expect(labels[i]!.label).not.toBe(labels[i - 1]!.label);
    }
    // Each label sits over the week that holds the 1st of its month.
    for (const { col, label } of labels.slice(1)) {
      const firsts = calendar.weeks[col]!.filter(
        (c): c is HeatCell => c !== null && parseLocalDay(c.date)!.getDate() === 1
      );
      expect(firsts).toHaveLength(1);
      expect(parseLocalDay(firsts[0]!.date)!.toLocaleDateString("en-US", { month: "short" })).toBe(
        label
      );
    }
  });

  it("returns an empty calendar for no days", () => {
    const calendar = buildPulseCalendar([]);
    expect(calendar.weeks).toEqual([]);
    expect(calendar.days).toEqual([]);
  });
});

describe("moveInCalendar — arrow keys follow the visual geometry", () => {
  const calendar = buildPulseCalendar(range(END, 60));
  const dateAt = (pos: { row: number; col: number } | null) =>
    pos ? calendar.weeks[pos.col]![pos.row]!.date : null;
  const shift = (date: string, days: number) => {
    const d = parseLocalDay(date)!;
    return isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
  };

  it("Left/Right move a whole week and Up/Down a single day, wherever both exist", () => {
    for (const cell of calendar.days) {
      const from = calendar.positions.get(cell.date)!;
      const right = dateAt(moveInCalendar(calendar, from, "ArrowRight"));
      const down = dateAt(moveInCalendar(calendar, from, "ArrowDown"));
      const plusWeek = shift(cell.date, 7);
      const plusDay = shift(cell.date, 1);
      if (calendar.positions.has(plusWeek)) expect(right).toBe(plusWeek);
      if (calendar.positions.has(plusDay) && from.row < DAYS_PER_WEEK - 1)
        expect(down).toBe(plusDay);
    }
  });

  it("never lands on a slot outside the range", () => {
    for (const cell of calendar.days) {
      const from = calendar.positions.get(cell.date)!;
      for (const key of [
        "ArrowRight",
        "ArrowLeft",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ] as const) {
        const to = moveInCalendar(calendar, from, key);
        if (to) expect(calendar.weeks[to.col]![to.row]).not.toBeNull();
      }
    }
  });

  it("can always reach the latest day moving right, even from a weekday it has not reached yet", () => {
    const latest = calendar.days[calendar.days.length - 1]!.date;
    // Start on the bottom row (Sunday) of the first full week; walk right.
    let pos = { row: DAYS_PER_WEEK - 1, col: 1 };
    for (let step = 0; step < calendar.weeks.length; step += 1) {
      pos = moveInCalendar(calendar, pos, "ArrowRight") ?? pos;
    }
    expect(pos.col).toBe(calendar.weeks.length - 1);
    expect(calendar.weeks[pos.col]![pos.row]).not.toBeNull();
    expect(dateAt(moveInCalendar(calendar, pos, "End", true))).toBe(latest);
  });

  it("does not wrap at the edges", () => {
    const first = calendar.positions.get(calendar.days[0]!.date)!;
    expect(moveInCalendar(calendar, first, "ArrowLeft")).toBeNull();
    const last = calendar.positions.get(calendar.days[calendar.days.length - 1]!.date)!;
    expect(moveInCalendar(calendar, last, "ArrowRight")).toBeNull();
  });

  it("Ctrl/Cmd+Home and +End reach the first and latest day of the range", () => {
    const mid = calendar.positions.get(calendar.days[30]!.date)!;
    expect(dateAt(moveInCalendar(calendar, mid, "Home", true))).toBe(calendar.days[0]!.date);
    expect(dateAt(moveInCalendar(calendar, mid, "End", true))).toBe(
      calendar.days[calendar.days.length - 1]!.date
    );
  });
});
