// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const state = {
  getPulse: (_id: string) => makePulse() as unknown,
  isLoading: (_id: string) => false,
  getError: (_id: string) => null as unknown,
  fetchPulse: vi.fn(),
};
vi.mock("@/store", () => ({
  usePulseStore: (selector: (s: typeof state) => unknown) => selector(state),
}));
vi.mock("../ProjectPulseCard", () => ({
  ProjectPulseCard: () => <div data-testid="pulse-card" />,
}));
vi.mock("../StreakFlame", () => ({ StreakFlame: () => <span /> }));

import { ProjectPulseStrip } from "../ProjectPulseStrip";

function cell(date: string, level: number) {
  return { date, count: level, level, isBeforeProject: false, isToday: false };
}
function makePulse() {
  return {
    heatmap: [cell("2026-06-01", 0), cell("2026-06-02", 3), cell("2026-06-03", 0)],
    commitsInRange: 9,
    activeDays: 5,
    projectAgeDays: 60,
    currentStreakDays: 2,
  };
}

/**
 * The collapsed ribbon is painted by inline `background` alone unless it opts
 * into the heatmap's shared cue mechanism. `forced-colors: active` overrides
 * author backgrounds to `Canvas`, and `src/index.css` restores legibility by
 * keying off `.pulse-heat-cell` + `data-heat-level` — so a cell that does not
 * carry those renders as nothing at all, and the strip loses its graph.
 *
 * These assert the CONTRACT (every cell participates; activity is encoded in
 * the attribute, not only in a colour), never a specific colour or size, so
 * they survive the ribbon being restyled.
 */
describe("pulse mini ribbon — forced-colors cue contract", () => {
  it("gives every ribbon cell the shared heat-cell hook", () => {
    render(<ProjectPulseStrip worktreeId="wt1" />);
    const ribbon = screen.getByTestId("pulse-mini-ribbon");
    const cells = Array.from(ribbon.children);
    expect(cells.length).toBeGreaterThan(0);
    for (const el of cells) {
      expect(el.classList.contains("pulse-heat-cell")).toBe(true);
    }
  });

  it("encodes an active day in an attribute, not only in a background colour", () => {
    render(<ProjectPulseStrip worktreeId="wt1" />);
    const ribbon = screen.getByTestId("pulse-mini-ribbon");
    const cells = Array.from(ribbon.children);
    const active = cells.filter((el) => el.hasAttribute("data-heat-level"));
    const quiet = cells.filter((el) => !el.hasAttribute("data-heat-level"));
    // The fixture has both kinds, so neither branch can pass vacuously.
    expect(active.length).toBeGreaterThan(0);
    expect(quiet.length).toBeGreaterThan(0);
    // An active cell carries the sized shape the forced-colors block paints.
    for (const el of active) {
      expect(el.querySelector(".pulse-heat-cell-shape")).not.toBeNull();
    }
    // A quiet day carries no shape — quiet is never drawn as a failure signal.
    for (const el of quiet) {
      expect(el.querySelector(".pulse-heat-cell-shape")).toBeNull();
    }
  });

  it("does not fall back to the panel surface for a quiet day", () => {
    // The ribbon sits on the canvas, not on a panel. Painting a quiet day in
    // `surface-panel` made it vanish on light themes; it must use a token that
    // lifts off whatever it is over.
    render(<ProjectPulseStrip worktreeId="wt1" />);
    const ribbon = screen.getByTestId("pulse-mini-ribbon");
    const quiet = Array.from(ribbon.children).filter(
      (el) => !el.hasAttribute("data-heat-level")
    ) as HTMLElement[];
    expect(quiet.length).toBeGreaterThan(0);
    for (const el of quiet) {
      expect(el.style.background).not.toContain("surface-panel");
      expect(el.style.background).toContain("overlay");
    }
  });
});
