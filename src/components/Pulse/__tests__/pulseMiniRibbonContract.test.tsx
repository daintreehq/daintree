// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Deliberately mixed: quiet, active, quiet, active-at-a-different-level. The
// expectations below are derived from THIS fixture, never from the rendered
// output, so an implementation that inverted the active predicate while
// keeping attribute, shape and style internally consistent still fails.
const FIXTURE = [
  { date: "2026-06-01", count: 0, level: 0 },
  { date: "2026-06-02", count: 3, level: 3 },
  { date: "2026-06-03", count: 0, level: 0 },
  { date: "2026-06-04", count: 1, level: 2 },
] as const;

const state = {
  getPulse: (_id: string) =>
    ({
      heatmap: FIXTURE.map((c) => ({ ...c, isBeforeProject: false, isToday: false })),
      commitsInRange: 4,
      activeDays: 2,
      projectAgeDays: 60,
      currentStreakDays: 1,
    }) as unknown,
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

function renderCells(): HTMLElement[] {
  render(<ProjectPulseStrip worktreeId="wt1" />);
  const ribbon = screen.getByTestId("pulse-mini-ribbon");
  const cells = Array.from(ribbon.children) as HTMLElement[];
  // The ribbon sorts by date and this fixture is already in date order, so
  // cell i is FIXTURE[i].
  expect(cells).toHaveLength(FIXTURE.length);
  return cells;
}

/**
 * The collapsed ribbon is painted by inline `background` alone unless it opts
 * into the heatmap's shared cue mechanism. `forced-colors: active` overrides
 * author backgrounds to `Canvas`, and `src/index.css` restores legibility by
 * keying off `.pulse-heat-cell` + `data-heat-level` — so a cell that does not
 * carry those renders as nothing at all, and the strip loses its graph.
 *
 * These assert the CONTRACT against the fixture — which day is active, at what
 * level, and which representation each kind of day gets — never a colour or a
 * size, so they survive the ribbon being restyled.
 */
describe("pulse mini ribbon — forced-colors cue contract", () => {
  it("gives every ribbon cell the shared heat-cell hook", () => {
    for (const el of renderCells()) {
      expect(el.classList.contains("pulse-heat-cell")).toBe(true);
    }
  });

  it("encodes each day's activity in an attribute that matches the fixture", () => {
    const cells = renderCells();
    FIXTURE.forEach((day, i) => {
      const el = cells[i]!;
      const active = day.count > 0 && day.level > 0;
      if (active) {
        // The level rides on the attribute the forced-colors size ladder keys
        // off, and it is the fixture's level, not merely "some level".
        expect(el.getAttribute("data-heat-level"), day.date).toBe(String(day.level));
        expect(el.querySelector(".pulse-heat-cell-shape"), day.date).not.toBeNull();
      } else {
        // A quiet day carries neither — quiet is never drawn as a signal.
        expect(el.hasAttribute("data-heat-level"), day.date).toBe(false);
        expect(el.querySelector(".pulse-heat-cell-shape"), day.date).toBeNull();
      }
    });
  });

  it("draws a quiet day as a class-driven boundary and an active day as a fill", () => {
    // Every overlay fill on this theme family lands within ~1.1:1 of the
    // canvas, so a quiet day has to be carried by a BORDER. And it has to be a
    // class, not an inline style: an inline border outranks the
    // `.pulse-heat-cell` rules `prefers-contrast: more` uses to lift every
    // cell's boundary, which would leave quiet days on the weaker border there.
    const cells = renderCells();
    FIXTURE.forEach((day, i) => {
      const el = cells[i]!;
      const active = day.count > 0 && day.level > 0;
      if (active) {
        expect(el.style.background, day.date).toBeTruthy();
        expect(el.classList.contains("border"), day.date).toBe(false);
      } else {
        expect(el.classList.contains("border"), day.date).toBe(true);
        expect(el.style.border, day.date).toBe("");
        expect(el.style.background, day.date).toBe("");
      }
    });
  });
});
