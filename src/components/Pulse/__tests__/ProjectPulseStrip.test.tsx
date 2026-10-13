// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Control the cached pulse the strip reads and capture fetch calls. The
// component reads via usePulseStore((s) => s.getPulse(id)),
// s.isLoading(id), s.getError(id), and s.fetchPulse; the mock applies each
// selector to our controllable state. getError is tri-state like the real
// store: undefined = never fetched (cold), null = settled "no commits", a
// string = a real error.
const state = {
  getPulse: (_id: string) => undefined as unknown,
  isLoading: (_id: string) => false,
  getError: (_id: string) => undefined as unknown,
  fetchPulse: vi.fn(),
};
vi.mock("@/store", () => ({
  usePulseStore: (selector: (s: typeof state) => unknown) => selector(state),
}));

// Stub the heavy expanded card + deps so the test stays about the strip's own
// collapse/expand + peek logic.
vi.mock("../ProjectPulseCard", () => ({
  ProjectPulseCard: () => <div data-testid="pulse-card">full card</div>,
}));
vi.mock("../PulseHeatmap", () => ({
  getPulseHeatLevelBackground: () => "transparent",
}));
vi.mock("../StreakFlame", () => ({
  StreakFlame: () => <span data-testid="streak-flame" />,
}));

import { ProjectPulseStrip } from "../ProjectPulseStrip";

function cell(date: string, level: number, extra: Record<string, unknown> = {}) {
  return { date, count: level, level, isBeforeProject: false, isToday: false, ...extra };
}

function makePulse(overrides: Record<string, unknown> = {}) {
  return {
    heatmap: [cell("2026-06-01", 3), cell("2026-06-02", 0, { isToday: true })],
    // Deliberately distinct from activeDays so a stat assertion can't pass by
    // accidentally reading the old commit-count headline.
    commitsInRange: 13,
    activeDays: 5,
    projectAgeDays: 60,
    currentStreakDays: 2,
    ...overrides,
  };
}

beforeEach(() => {
  state.getPulse = () => undefined;
  state.isLoading = () => false;
  state.getError = () => undefined;
  state.fetchPulse.mockClear();
});

describe("ProjectPulseStrip", () => {
  it("populates on mount by fetching when nothing is cached, staying collapsed", () => {
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(screen.getByRole("button", { name: /^project pulse/i })).toBeTruthy();
    // Populate-on-load: the cold strip kicks a fetch on mount so the peek fills
    // without needing a first expand — but stays collapsed until clicked.
    expect(state.fetchPulse).toHaveBeenCalledWith("wt1");
    expect(screen.queryByTestId("pulse-card")).toBeNull();
  });

  it("shows a 'View activity' fallback while the mount fetch is still resolving", () => {
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(screen.getByText(/view activity/i)).toBeTruthy();
    expect(screen.queryByTestId("pulse-mini-ribbon")).toBeNull();
  });

  it("does not fetch on mount when a pulse is already cached", () => {
    state.getPulse = () => makePulse();
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(state.fetchPulse).not.toHaveBeenCalled();
  });

  it("does not fetch on mount while a request is already in flight", () => {
    state.isLoading = () => true;
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(state.fetchPulse).not.toHaveBeenCalled();
  });

  it("does not fetch on mount when the last fetch errored (store handles retry)", () => {
    state.getError = () => "Unable to load activity data";
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(state.fetchPulse).not.toHaveBeenCalled();
  });

  it("does not refetch on mount once a fetch settled with no error (no-commits repo)", () => {
    // A settled null error (distinct from the cold undefined) means a fetch
    // already ran and classified the repo as commit-less. The mount guard keys
    // on `error === undefined`, so null counts as "already attempted" — treating
    // it as falsy would spin a tight refetch loop against git/IPC.
    state.getError = () => null;
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(state.fetchPulse).not.toHaveBeenCalled();
  });

  it("peeks cached stats — active days (not a raw commit count), streak, and a mini ribbon", () => {
    state.getPulse = () => makePulse();
    render(<ProjectPulseStrip worktreeId="wt1" />);
    // Scoped to the window it counts, matching the card summary's "5/60".
    expect(screen.getByText("5/60 active days")).toBeTruthy();
    expect(screen.getByText("2 day streak")).toBeTruthy();
    // The busyness-flavored commit count is no longer the headline (#11194).
    expect(screen.queryByText(/13 commits/i)).toBeNull();
    expect(screen.getByTestId("streak-flame")).toBeTruthy();
    expect(screen.getByTestId("pulse-mini-ribbon")).toBeTruthy();
  });

  it("scopes the active-day count to the snapshot's own window, not a fixed one", () => {
    state.getPulse = () => makePulse({ activeDays: 3, projectAgeDays: 4, currentStreakDays: 1 });
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(screen.getByText("3/4 active days")).toBeTruthy();
  });

  it("folds the peeked stats into the button's accessible name for screen readers", () => {
    state.getPulse = () => makePulse({ activeDays: 5, currentStreakDays: 2 });
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(
      screen.getByRole("button", {
        name: /^project pulse — 5 of 60 active days, 2 day streak, show activity$/i,
      })
    ).toBeTruthy();
  });

  it("scopes the accessible name the same way and omits a 1-day streak", () => {
    state.getPulse = () => makePulse({ activeDays: 1, currentStreakDays: 1 });
    render(<ProjectPulseStrip worktreeId="wt1" />);
    // Anchored so a spurious streak suffix fails.
    expect(
      screen.getByRole("button", { name: /^project pulse — 1 of 60 active days, show activity$/i })
    ).toBeTruthy();
  });

  it("omits the streak peek when the streak is 1 day or less", () => {
    state.getPulse = () => makePulse({ currentStreakDays: 1 });
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(screen.queryByTestId("streak-flame")).toBeNull();
  });

  it("expands to the full card on click, fetches fresh data, and collapses again", () => {
    render(<ProjectPulseStrip worktreeId="wt1" />);
    // The cold-cache mount fetch already fired; clear it so we assert only the
    // click-triggered fetch (a bare vi.fn() doesn't model the store's dedupe).
    state.fetchPulse.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^project pulse/i }));
    expect(screen.getByTestId("pulse-card")).toBeTruthy();
    // Expanding kicks a (deduped) fetch so the peek is fresh + the card opens on
    // a skeleton rather than a blank frame.
    expect(state.fetchPulse).toHaveBeenCalledWith("wt1");
    expect(state.fetchPulse).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /collapse/i }));
    expect(screen.queryByTestId("pulse-card")).toBeNull();
    expect(screen.getByRole("button", { name: /^project pulse/i })).toBeTruthy();
  });

  it("mini ribbon drops invalid-date and before-project cells and never triggers a fetch", () => {
    state.getPulse = () =>
      makePulse({
        heatmap: [
          cell("2026-06-03", 2),
          cell("bogus-date", 4),
          cell("2026-06-01", 1),
          cell("2026-05-01", 4, { isBeforeProject: true }),
          cell("2026-06-02", 3),
        ],
      });
    render(<ProjectPulseStrip worktreeId="wt1" />);
    // Only the 3 valid, in-project cells survive; invalid date + before-project
    // are filtered out. (The peek reads cache only — never a fetch.)
    expect(screen.getByTestId("pulse-mini-ribbon").children.length).toBe(3);
    expect(state.fetchPulse).not.toHaveBeenCalled();
  });

  it("mini ribbon caps at the most recent 18 days", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      cell(`2026-06-${String(i + 1).padStart(2, "0")}`, (i % 4) + 1)
    );
    state.getPulse = () => makePulse({ heatmap: many });
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(screen.getByTestId("pulse-mini-ribbon").children.length).toBe(18);
  });
});

// Deliberately mixed: quiet, active, quiet, active-at-a-different-level. The
// expectations below are derived from THIS fixture, never from the rendered
// output, so an implementation that inverted the active predicate while
// keeping attribute, shape and style internally consistent still fails.
const RIBBON_FIXTURE = [
  { date: "2026-06-01", count: 0, level: 0 },
  { date: "2026-06-02", count: 3, level: 3 },
  { date: "2026-06-03", count: 0, level: 0 },
  { date: "2026-06-04", count: 1, level: 2 },
] as const;

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
  beforeEach(() => {
    state.getPulse = () =>
      makePulse({
        heatmap: RIBBON_FIXTURE.map((c) => ({ ...c, isBeforeProject: false, isToday: false })),
      });
  });

  function renderCells(): HTMLElement[] {
    render(<ProjectPulseStrip worktreeId="wt1" />);
    const ribbon = screen.getByTestId("pulse-mini-ribbon");
    const cells = Array.from(ribbon.children) as HTMLElement[];
    // The ribbon sorts by date and this fixture is already in date order, so
    // cell i is RIBBON_FIXTURE[i].
    expect(cells).toHaveLength(RIBBON_FIXTURE.length);
    return cells;
  }

  it("gives every ribbon cell the shared heat-cell hook", () => {
    for (const el of renderCells()) {
      expect(el.classList.contains("pulse-heat-cell")).toBe(true);
    }
  });

  it("encodes each day's activity in an attribute that matches the fixture", () => {
    const cells = renderCells();
    RIBBON_FIXTURE.forEach((day, i) => {
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
    RIBBON_FIXTURE.forEach((day, i) => {
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
