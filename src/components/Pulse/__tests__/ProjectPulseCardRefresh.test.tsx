// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const state = vi.hoisted(() => ({
  loading: false,
  fetchPulse: vi.fn(),
  refreshHealth: vi.fn(),
}));

vi.mock("@/store", () => ({
  PULSE_MAX_RETRIES: 3,
  usePulseStore: (selector: (s: unknown) => unknown) =>
    selector({
      getPulse: () => ({
        heatmap: [],
        commitsInRange: 0,
        activeDays: 0,
        projectAgeDays: 60,
        currentStreakDays: 0,
        rangeDays: 60,
        generatedAt: Date.now(),
      }),
      isLoading: () => state.loading,
      getError: () => undefined,
      getRetryCount: () => 0,
      rangeDays: 60,
      fetchPulse: state.fetchPulse,
      setRangeDays: vi.fn(),
    }),
  useProjectStore: (selector: (s: unknown) => unknown) => selector({ currentProject: null }),
}));
vi.mock("@/hooks/useProjectHealth", () => ({
  useProjectHealth: () => ({ health: null, loading: false, refresh: state.refreshHealth }),
}));
vi.mock("@/hooks/useGlobalMinuteTicker", () => ({ useGlobalMinuteTicker: () => 0 }));
vi.mock("../PulseHeatmap", () => ({
  PulseHeatmap: () => null,
  getPulseHeatLevelBackground: () => "transparent",
}));
vi.mock("../PulseSummary", () => ({ PulseSummary: () => null }));
vi.mock("../PulseHealthSignals", () => ({ PulseHealthSignals: () => null }));

import { ProjectPulseCard } from "../ProjectPulseCard";

beforeEach(() => {
  state.loading = false;
  state.fetchPulse.mockClear();
  state.refreshHealth.mockClear();
});

describe("ProjectPulseCard footer refresh button", () => {
  it("refreshes when idle", () => {
    render(<ProjectPulseCard worktreeId="wt1" />);
    fireEvent.click(screen.getByTestId("pulse-last-updated"));
    expect(state.fetchPulse).toHaveBeenCalledWith("wt1", true);
  });

  it("stays focusable and not natively disabled while loading, and ignores activation", () => {
    state.loading = true;
    render(<ProjectPulseCard worktreeId="wt1" />);
    const button = screen.getByTestId("pulse-last-updated") as HTMLButtonElement;
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(state.fetchPulse).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });
});
