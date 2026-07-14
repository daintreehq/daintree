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
