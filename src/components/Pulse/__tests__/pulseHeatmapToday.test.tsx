// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HeatCell } from "@shared/types";
import { PulseHeatmap } from "../PulseHeatmap";
import { TooltipProvider } from "../../ui/tooltip";

function renderWith(cells: HeatCell[]) {
  return render(
    <TooltipProvider>
      <PulseHeatmap cells={cells} rangeDays={60} />
    </TooltipProvider>
  );
}

const cellEl = (date: string) => document.querySelector<HTMLElement>(`[data-cell-date="${date}"]`)!;

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
    renderWith(cells);
    const label = document.querySelector<HTMLElement>('[data-testid="pulse-heatmap-today"]')!;
    expect(label.textContent).toBe("Today");

    const today = cellEl("2026-09-23");
    expect(today.getAttribute("aria-label")).toMatch(/^Today, /);

    // Only today says "Today"; the latest-active day keeps its own meaning.
    expect(cellEl("2026-09-22").getAttribute("aria-label")).not.toMatch(/Today/);
    expect(cellEl("2026-09-22").hasAttribute("data-latest-active")).toBe(true);
    expect(today.hasAttribute("data-latest-active")).toBe(false);
  });

  it("moves the label with today's weekday row", () => {
    // 2026-09-21 is a Monday (top row), 22 a Tuesday, 23 a Wednesday.
    const topFor = (todayDate: string) => {
      const { unmount } = renderWith(cells.map((c) => ({ ...c, isToday: c.date === todayDate })));
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
    renderWith(cells.map((c) => ({ ...c, isToday: false })));
    expect(document.querySelector('[data-testid="pulse-heatmap-today"]')).toBeNull();
  });
});
