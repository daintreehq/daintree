// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { HeatCell } from "@shared/types";
import { PulseHeatmap } from "../PulseHeatmap";
import { TooltipProvider } from "../../ui/tooltip";

// #11172: the heatmap must have no way to express failure. A zero-commit day
// bracketed by active days used to be styled as a "missed day" — a danger tint,
// an inset ring, and a "Missed day" label. Every quiet day now reads the same,
// whatever its neighbours did.

function cell(day: number, count: number): HeatCell {
  return {
    date: `2026-01-${String(day).padStart(2, "0")}`,
    count,
    level: Math.min(4, count) as HeatCell["level"],
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

function renderHeatmap() {
  return render(
    <TooltipProvider>
      <PulseHeatmap cells={CELLS} rangeDays={60} />
    </TooltipProvider>
  );
}

function cellByDate(date: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-cell-date="${date}"]`);
  if (!el) throw new Error(`no cell rendered for ${date}`);
  return el;
}

describe("PulseHeatmap — a quiet day is never a failure", () => {
  it("styles a zero day bracketed by activity exactly like an isolated zero day", () => {
    renderHeatmap();
    const bracketed = cellByDate("2026-01-03");
    const isolated = cellByDate("2026-01-07");

    expect(bracketed.style.background).toBe(isolated.style.background);
    expect(bracketed.className).toBe(isolated.className);
  });

  it("labels every zero day 'No commits', including the formerly-missed one", () => {
    renderHeatmap();
    for (const date of ["2026-01-03", "2026-01-06", "2026-01-07", "2026-01-08"]) {
      expect(cellByDate(date).getAttribute("aria-label")).toContain("No commits");
    }
    expect(screen.queryByLabelText(/missed/i)).toBeNull();
  });

  it("gives a zero day no heat level and no shape cue", () => {
    renderHeatmap();
    // data-heat-level and the shape span are what forced-colors mode keys off;
    // a quiet day must carry neither, or it would paint as a signal.
    const quiet = cellByDate("2026-01-03");
    expect(quiet.hasAttribute("data-heat-level")).toBe(false);
    expect(quiet.querySelector(".pulse-heat-cell-shape")).toBeNull();
  });

  it("still distinguishes days that actually had commits", () => {
    renderHeatmap();
    const worked = cellByDate("2026-01-04");
    const quiet = cellByDate("2026-01-03");
    expect(worked.style.background).not.toBe(quiet.style.background);
    expect(worked.getAttribute("aria-label")).toContain("4 commits");
    expect(worked.getAttribute("data-heat-level")).toBe("4");
  });
});
