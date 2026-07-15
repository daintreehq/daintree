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
    expect(screen.getByRole("button", { name: /show project activity/i })).toBeTruthy();
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
    expect(screen.getByText(/5 active days/i)).toBeTruthy();
    // The busyness-flavored commit count is no longer the headline (#11194).
    expect(screen.queryByText(/13 commits/i)).toBeNull();
    expect(screen.getByTestId("streak-flame")).toBeTruthy();
    expect(screen.getByTestId("pulse-mini-ribbon")).toBeTruthy();
  });

  it("renders a singular 'active day' for a one-day-active pulse", () => {
    state.getPulse = () => makePulse({ activeDays: 1, currentStreakDays: 1 });
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(screen.getByText(/1 active day\b/i)).toBeTruthy();
    expect(screen.queryByText(/active days/i)).toBeNull();
  });

  it("folds the peeked stats into the button's accessible name for screen readers", () => {
    state.getPulse = () => makePulse({ activeDays: 5, currentStreakDays: 2 });
    render(<ProjectPulseStrip worktreeId="wt1" />);
    expect(
      screen.getByRole("button", { name: /show project activity — 5 active days, 2 day streak/i })
    ).toBeTruthy();
  });

  it("uses a singular 'active day' in the accessible name and omits a 1-day streak", () => {
    state.getPulse = () => makePulse({ activeDays: 1, currentStreakDays: 1 });
    render(<ProjectPulseStrip worktreeId="wt1" />);
    // Anchored so "1 active days" (plural bug) or a spurious streak suffix fails.
    expect(
      screen.getByRole("button", { name: /^show project activity — 1 active day$/i })
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
    fireEvent.click(screen.getByRole("button", { name: /show project activity/i }));
    expect(screen.getByTestId("pulse-card")).toBeTruthy();
    // Expanding kicks a (deduped) fetch so the peek is fresh + the card opens on
    // a skeleton rather than a blank frame.
    expect(state.fetchPulse).toHaveBeenCalledWith("wt1");
    expect(state.fetchPulse).toHaveBeenCalledTimes(1);

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
