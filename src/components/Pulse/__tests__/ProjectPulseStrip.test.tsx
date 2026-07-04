// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Control the cached pulse the strip reads and capture fetch-on-expand. The
// component reads via usePulseStore((s) => s.getPulse(id)) and
// usePulseStore((s) => s.fetchPulse); the mock applies each selector to our
// controllable state.
const state = {
  getPulse: (_id: string) => undefined as unknown,
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
    commitsInRange: 13,
    currentStreakDays: 2,
    ...overrides,
  };
}

beforeEach(() => {
  state.getPulse = () => undefined;
  state.fetchPulse.mockClear();
});

describe("ProjectPulseStrip", () => {
  it("renders collapsed by default with no full card mounted and no fetch", () => {
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(screen.getByRole("button", { name: /show project activity/i })).toBeTruthy();
    expect(screen.queryByTestId("pulse-card")).toBeNull();
    expect(state.fetchPulse).not.toHaveBeenCalled();
  });

  it("shows a 'View activity' hint (no git scan) when nothing is cached", () => {
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(screen.getByText(/view activity/i)).toBeTruthy();
    expect(screen.queryByTestId("pulse-mini-ribbon")).toBeNull();
  });

  it("peeks cached stats — commit count, streak, and a mini ribbon", () => {
    state.getPulse = () => makePulse();
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(screen.getByText(/13 commits/i)).toBeTruthy();
    expect(screen.getByTestId("streak-flame")).toBeTruthy();
    expect(screen.getByTestId("pulse-mini-ribbon")).toBeTruthy();
  });

  it("folds the peeked stats into the button's accessible name for screen readers", () => {
    state.getPulse = () => makePulse({ commitsInRange: 13, currentStreakDays: 2 });
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(
      screen.getByRole("button", { name: /show project activity — 13 commits, 2 day streak/i })
    ).toBeTruthy();
  });

  it("omits the streak peek when the streak is 1 day or less", () => {
    state.getPulse = () => makePulse({ currentStreakDays: 1 });
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(screen.queryByTestId("streak-flame")).toBeNull();
  });

  it("expands to the full card on click, fetches fresh data, and collapses again", () => {
    render(<ProjectPulseStrip worktreeId="wt1" />);
    fireEvent.click(screen.getByRole("button", { name: /show project activity/i }));
    expect(screen.getByTestId("pulse-card")).toBeTruthy();
    // Expanding kicks a (deduped) fetch so the peek is fresh + the card opens on
    // a skeleton rather than a blank frame.
    expect(state.fetchPulse).toHaveBeenCalledWith("wt1");

    fireEvent.click(screen.getByRole("button", { name: /collapse/i }));
    expect(screen.queryByTestId("pulse-card")).toBeNull();
    expect(screen.getByRole("button", { name: /show project activity/i })).toBeTruthy();
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
