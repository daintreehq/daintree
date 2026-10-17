// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { HeatCell } from "@shared/types";
import { PulseHeatmap } from "../PulseHeatmap";
import { TooltipProvider } from "../../ui/tooltip";

// #11172: the heatmap must have no way to express failure. A zero-commit day
// bracketed by active days used to be styled as a "missed day" — a danger tint,
// an inset ring, and a "Missed day" label. Every quiet day now reads the same,
// whatever its neighbours did.

function heatLevel(count: number): HeatCell["level"] {
  if (count >= 4) return 4;
  if (count === 3) return 3;
  if (count === 2) return 2;
  if (count === 1) return 1;
  return 0;
}

function cell(day: number, count: number): HeatCell {
  return {
    date: `2026-01-${String(day).padStart(2, "0")}`,
    count,
    level: heatLevel(count),
  };
}

// Day 03 is a zero bracketed by activity on both sides — the exact shape the
// old isMissedDay() flagged. Day 07 is an isolated zero with no activity near
// it, which it never flagged.
const CELLS: HeatCell[] = [
  cell(1, 3),
  cell(2, 2),
  cell(3, 0),
  cell(4, 4),
  cell(5, 1),
  cell(6, 0),
  cell(7, 0),
  cell(8, 0),
];

function renderHeatmap(cells: HeatCell[] = CELLS) {
  return render(
    <TooltipProvider>
      <PulseHeatmap cells={cells} rangeDays={60} />
    </TooltipProvider>
  );
}

function cellByDate(date: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-cell-date="${date}"]`);
  if (!el) throw new Error(`no cell rendered for ${date}`);
  return el;
}

// The date prefix differs per cell; the state description is what must match.
function stateOf(date: string): string {
  const label = cellByDate(date).getAttribute("aria-label") ?? "";
  return label.slice(label.indexOf(":") + 1).trim();
}

describe("PulseHeatmap — a quiet day is never a failure", () => {
  it("styles a zero day bracketed by activity exactly like an isolated zero day", () => {
    renderHeatmap();
    const bracketed = cellByDate("2026-01-03");
    const isolated = cellByDate("2026-01-07");

    // Under the old isMissedDay(), the bracketed cell alone got a danger tint
    // and the .pulse-heat-cell-missed ring.
    expect(bracketed.style.background).toBe(isolated.style.background);
    expect(bracketed.className).toBe(isolated.className);
  });

  it("describes every zero day the same way, whatever its neighbours did", () => {
    renderHeatmap();
    const quietDays = ["2026-01-03", "2026-01-06", "2026-01-07", "2026-01-08"];
    const described = quietDays.map(stateOf);

    // Every zero day must actually SAY something — otherwise "they all match"
    // would hold vacuously if the labels went missing.
    for (const state of described) {
      expect(state.length).toBeGreaterThan(0);
      // Whatever the wording, it can't be a failure. The old one was "Missed day".
      expect(state).not.toMatch(/miss|fail|break|broke|lost|skip/i);
    }
    expect(new Set(described).size).toBe(1);
    expect(screen.queryByLabelText(/missed/i)).toBeNull();
  });

  it("gives a zero day no forced-colors shape cue", () => {
    renderHeatmap();
    // The shape span is painted solid CanvasText under forced-colors. A quiet
    // day carrying one would become a signal again, by a different route than
    // the background this suite guards above.
    for (const date of ["2026-01-03", "2026-01-07"]) {
      const quiet = cellByDate(date);
      expect(quiet.querySelector(".pulse-heat-cell-shape")).toBeNull();
      expect(quiet.hasAttribute("data-heat-level")).toBe(false);
    }
  });

  it("still distinguishes days that actually had commits", () => {
    // Positive control: the equality above must not be holding because every
    // cell collapsed to one rendering.
    renderHeatmap();
    const worked = cellByDate("2026-01-04");
    const quiet = cellByDate("2026-01-03");
    expect(worked.style.background).not.toBe(quiet.style.background);
    expect(stateOf("2026-01-04")).not.toBe(stateOf("2026-01-03"));
    expect(worked.getAttribute("data-heat-level")).toBe("4");
    expect(worked.querySelector(".pulse-heat-cell-shape")).not.toBeNull();
  });
});

describe("PulseHeatmap — today is named, not inferred", () => {
  // Today is a quiet day here, so the latest-active ring sits elsewhere — the
  // case where "the ringed cell" and "today" would otherwise be confused.
  const cells: HeatCell[] = [
    { date: "2026-09-20", count: 3, level: 3, isMostRecentActive: false },
    { date: "2026-09-21", count: 2, level: 2 },
    { date: "2026-09-22", count: 4, level: 4, isMostRecentActive: true },
    { date: "2026-09-23", count: 0, level: 0, isToday: true },
  ];

  it("labels today's row beside the grid and names today in its cell", () => {
    renderHeatmap(cells);
    const label = document.querySelector<HTMLElement>('[data-testid="pulse-heatmap-today"]')!;
    expect(label.textContent).toBe("Today");

    const today = cellByDate("2026-09-23");
    expect(today.getAttribute("aria-label")).toMatch(/^Today, /);

    // Only today says "Today"; the latest-active day keeps its own meaning.
    expect(cellByDate("2026-09-22").getAttribute("aria-label")).not.toMatch(/Today/);
    expect(cellByDate("2026-09-22").hasAttribute("data-latest-active")).toBe(true);
    expect(today.hasAttribute("data-latest-active")).toBe(false);
  });

  it("moves the label with today's weekday row", () => {
    // 2026-09-21 is a Monday (top row), 22 a Tuesday, 23 a Wednesday.
    const topFor = (todayDate: string) => {
      const { unmount } = renderHeatmap(
        cells.map((c) => ({ ...c, isToday: c.date === todayDate }))
      );
      const top = parseFloat(
        document.querySelector<HTMLElement>('[data-testid="pulse-heatmap-today"]')!.style.top
      );
      unmount();
      return top;
    };
    const monday = topFor("2026-09-21");
    const tuesday = topFor("2026-09-22");
    const wednesday = topFor("2026-09-23");
    expect(monday).toBe(0);
    expect(tuesday).toBeGreaterThan(0);
    expect(wednesday).toBe(2 * tuesday);
  });

  it("draws no today label when the range does not include today", () => {
    renderHeatmap(cells.map((c) => ({ ...c, isToday: false })));
    expect(document.querySelector('[data-testid="pulse-heatmap-today"]')).toBeNull();
  });
});

describe("PulseHeatmap — a day's tooltip is its readout, not a passing hint", () => {
  const cells: HeatCell[] = [
    { date: "2026-09-21", count: 2, level: 2 },
    { date: "2026-09-22", count: 5, level: 4 },
    { date: "2026-09-23", count: 0, level: 0 },
    { date: "2026-09-24", count: 1, level: 1, isToday: true, isMostRecentActive: true },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the focused day's date and count on screen past the app's hint window", async () => {
    renderHeatmap(cells);
    // Radix loads lazily; let the loader settle before driving focus.
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const cell = cellByDate("2026-09-22");
    act(() => {
      cell.focus();
      fireEvent.focus(cell);
    });
    const shown = () => document.body.textContent ?? "";
    expect(shown()).toContain("5 commits");

    // The app-wide tooltip wrapper auto-hides hints after a fixed window. A
    // heatmap day has no other visible place its count lives, so it must
    // outlast that window while the cell holds focus.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(shown()).toContain("5 commits");
  });
});
