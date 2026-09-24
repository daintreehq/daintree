import type { HeatCell } from "@shared/types";

export const DAYS_PER_WEEK = 7;

// Rows are Monday-first so Saturday and Sunday sit together at the bottom and
// a weekday-only rhythm reads as one quiet band rather than two split edges.
export const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""] as const;

// A short month name needs about three cell pitches; a label closer than this
// to the next one would collide with it.
const MIN_MONTH_LABEL_GAP = 3;

/**
 * `HeatCell.date` is a local calendar day ("YYYY-MM-DD"). `new Date(string)`
 * parses that form as UTC midnight, which lands on the previous day anywhere
 * west of Greenwich — so build the date from its parts in local time.
 */
export function parseLocalDay(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(day.getTime()) ? null : day;
}

export function weekdayIndex(day: Date): number {
  return (day.getDay() + 6) % DAYS_PER_WEEK;
}

export interface CalendarPosition {
  row: number;
  col: number;
}

export interface PulseCalendar {
  /** Column-major: `weeks[col][row]`, `null` where the range has no day. */
  weeks: (HeatCell | null)[][];
  monthLabels: { col: number; label: string }[];
  positions: Map<string, CalendarPosition>;
  /** Real days in chronological order. */
  days: HeatCell[];
}

function addDays(day: Date, amount: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + amount);
}

/**
 * Lay the range out as a week-column calendar: one column per week, one row
 * per weekday. Slots before the first day or after the last are `null` rather
 * than quiet days — the range simply does not cover them.
 */
export function buildPulseCalendar(cells: HeatCell[]): PulseCalendar {
  const dated = cells
    .filter((cell) => !cell.isBeforeProject)
    .map((cell) => ({ cell, day: parseLocalDay(cell.date) }))
    .filter((entry): entry is { cell: HeatCell; day: Date } => entry.day !== null)
    .sort((a, b) => a.day.getTime() - b.day.getTime());

  const weeks: (HeatCell | null)[][] = [];
  const positions = new Map<string, CalendarPosition>();
  const monthLabels: { col: number; label: string }[] = [];
  const first = dated[0];
  if (!first) return { weeks, monthLabels, positions, days: [] };

  const start = addDays(first.day, -weekdayIndex(first.day));
  const byDay = new Map(dated.map(({ cell, day }) => [day.getTime(), cell]));
  const last = dated[dated.length - 1]!.day;

  let lastLabelledMonth = -1;
  for (
    let weekStart = start, col = 0;
    weekStart <= last;
    weekStart = addDays(weekStart, 7), col += 1
  ) {
    const week: (HeatCell | null)[] = [];
    for (let row = 0; row < DAYS_PER_WEEK; row += 1) {
      const day = addDays(weekStart, row);
      const cell = byDay.get(day.getTime()) ?? null;
      week.push(cell);
      if (!cell) continue;
      positions.set(cell.date, { row, col });

      // A month is labelled over the week holding its first day in range —
      // the 1st, or the range's opening day for the leading partial month —
      // so the axis marks where each month actually begins. A week holds at
      // most one month start; if the range opens in its last days, the later
      // month takes the column.
      const monthKey = day.getFullYear() * 12 + day.getMonth();
      if (monthKey !== lastLabelledMonth) {
        lastLabelledMonth = monthKey;
        const label = day.toLocaleDateString("en-US", { month: "short" });
        if (monthLabels[monthLabels.length - 1]?.col === col) monthLabels.pop();
        monthLabels.push({ col, label });
      }
    }
    weeks.push(week);
  }

  // When two labels would collide, drop the earlier one: it names a partial
  // leading month, while the later one marks where a whole month begins.
  const spaced = monthLabels.filter(
    (label, index) =>
      index === monthLabels.length - 1 ||
      monthLabels[index + 1]!.col - label.col >= MIN_MONTH_LABEL_GAP
  );

  // A date listed twice keeps its last entry in the grid; the chronological
  // list keeps the same one so keyboard ends agree with what is drawn.
  const days = dated
    .filter(({ cell, day }) => byDay.get(day.getTime()) === cell)
    .map(({ cell }) => cell);

  return { weeks, monthLabels: spaced, positions, days };
}

export type CalendarKey = "ArrowRight" | "ArrowLeft" | "ArrowUp" | "ArrowDown" | "Home" | "End";

function nearestInColumn(
  weeks: (HeatCell | null)[][],
  col: number,
  row: number
): CalendarPosition | null {
  const week = weeks[col];
  if (!week) return null;
  for (let distance = 0; distance < DAYS_PER_WEEK; distance += 1) {
    for (const candidate of [row - distance, row + distance]) {
      if (candidate >= 0 && candidate < DAYS_PER_WEEK && week[candidate]) {
        return { row: candidate, col };
      }
    }
  }
  return null;
}

/**
 * Arrow keys follow the visual geometry: Left/Right move a week, Up/Down move a
 * day. Moving into a slot the range does not cover lands on the nearest real
 * day in that week instead, so the latest days are always reachable. Edges do
 * not wrap. Home/End go to the ends of the weekday row; with `toEnds` (Ctrl or
 * Cmd) they go to the first and latest day of the whole range.
 */
export function moveInCalendar(
  calendar: PulseCalendar,
  from: CalendarPosition,
  key: CalendarKey,
  toEnds = false
): CalendarPosition | null {
  const { weeks } = calendar;
  const lastCol = weeks.length - 1;
  switch (key) {
    case "ArrowRight":
      return from.col < lastCol ? nearestInColumn(weeks, from.col + 1, from.row) : null;
    case "ArrowLeft":
      return from.col > 0 ? nearestInColumn(weeks, from.col - 1, from.row) : null;
    case "ArrowDown":
      for (let row = from.row + 1; row < DAYS_PER_WEEK; row += 1) {
        if (weeks[from.col]?.[row]) return { row, col: from.col };
      }
      return null;
    case "ArrowUp":
      for (let row = from.row - 1; row >= 0; row -= 1) {
        if (weeks[from.col]?.[row]) return { row, col: from.col };
      }
      return null;
    case "Home":
    case "End": {
      if (toEnds) {
        const target = key === "Home" ? calendar.days[0] : calendar.days[calendar.days.length - 1];
        return target ? (calendar.positions.get(target.date) ?? null) : null;
      }
      const cols = weeks.map((_, col) => col);
      if (key === "End") cols.reverse();
      for (const col of cols) {
        if (weeks[col]?.[from.row]) return { row: from.row, col };
      }
      return null;
    }
  }
}
