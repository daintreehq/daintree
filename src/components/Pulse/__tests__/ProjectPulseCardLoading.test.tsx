// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ProjectPulse, PulseRangeDays } from "@shared/types";

const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));
vi.mock("@/store", async () => {
  const pulse = await import("@/store/pulseStore");
  return { usePulseStore: pulse.usePulseStore, PULSE_MAX_RETRIES: pulse.PULSE_MAX_RETRIES };
});
vi.mock("@/hooks/useProjectHealth", () => ({
  useProjectHealth: () => ({ health: null, loading: false, refresh: vi.fn() }),
}));
vi.mock("@/hooks/useGlobalMinuteTicker", () => ({ useGlobalMinuteTicker: () => 0 }));
vi.mock("../PulseHeatmap", () => ({
  PulseHeatmap: ({ rangeDays }: { rangeDays: number }) => (
    <div data-testid="pulse-heatmap" data-range={rangeDays} />
  ),
  getPulseHeatLevelBackground: () => "transparent",
}));
vi.mock("../PulseSummary", () => ({ PulseSummary: () => null }));
vi.mock("../PulseHealthSignals", () => ({ PulseHealthSignals: () => null }));

import { usePulseStore } from "@/store/pulseStore";
import { ProjectPulseCard } from "../ProjectPulseCard";

function makePulse(rangeDays: PulseRangeDays, overrides: Partial<ProjectPulse> = {}): ProjectPulse {
  return {
    worktreeId: "wt1",
    worktreePath: "/repo",
    branch: "main",
    mainBranch: "main",
    rangeDays,
    generatedAt: Date.now(),
    heatmap: [{ date: "2026-11-12", count: 2, level: 2 }],
    commitsInRange: 2,
    activeDays: 1,
    projectAgeDays: rangeDays,
    currentStreakDays: 1,
    recentCommits: [],
    ...overrides,
  } as ProjectPulse;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function settle(resolve: (value: unknown) => void, pulse: ProjectPulse) {
  await act(async () => {
    resolve({ ok: true, result: pulse });
  });
}

function seed(pulse: ProjectPulse) {
  usePulseStore.setState({
    pulses: new Map([["wt1", pulse]]),
    loading: new Map(),
    errors: new Map([["wt1", null]]),
    rangeDays: pulse.rangeDays,
    requestIds: new Map(),
    retryCount: new Map(),
    lastRetryTimestamp: new Map(),
    retryTimers: new Map(),
  });
}

function liveRegionText() {
  return screen.getByRole("status").textContent ?? "";
}

function refreshIconSpins() {
  const button = screen.getByRole("button", { name: "Refresh" });
  return button.querySelector(".animate-spin") !== null;
}

beforeEach(() => {
  vi.useFakeTimers();
  dispatchMock.mockReset();
  dispatchMock.mockReturnValue(new Promise(() => {}));
  seed(makePulse(60));
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("ProjectPulseCard range change", () => {
  it("keeps the range control mounted and focused while the new range loads", async () => {
    const request = deferred<unknown>();
    dispatchMock.mockReturnValueOnce(request.promise);
    render(<ProjectPulseCard worktreeId="wt1" />);

    const sixty = screen.getByRole("radio", { name: "60 days" });
    sixty.focus();
    fireEvent.keyDown(sixty, { key: "ArrowRight" });

    const oneTwenty = screen.getByRole("radio", { name: "120 days" });
    expect(oneTwenty.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(oneTwenty);
    expect(dispatchMock).toHaveBeenCalledWith(
      "git.getProjectPulse",
      expect.objectContaining({ worktreeId: "wt1", rangeDays: 120 }),
      { source: "user" }
    );
    // The last snapshot stays on screen until the new window lands.
    expect(screen.getByTestId("pulse-heatmap").getAttribute("data-range")).toBe("60");

    await settle(request.resolve, makePulse(120));

    expect(screen.getByTestId("pulse-heatmap").getAttribute("data-range")).toBe("120");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "120 days" }));
  });

  it("keeps the range control focused when the new range fails to load", async () => {
    const request = deferred<unknown>();
    dispatchMock.mockReturnValueOnce(request.promise);
    render(<ProjectPulseCard worktreeId="wt1" />);

    const sixty = screen.getByRole("radio", { name: "60 days" });
    sixty.focus();
    fireEvent.keyDown(sixty, { key: "ArrowRight" });
    await act(async () => {
      request.resolve({ ok: false, error: { message: "boom" } });
    });

    expect(screen.getByRole("alert").textContent).toContain("Unable to load activity data");
    expect(screen.queryByTestId("pulse-heatmap")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "120 days" }));
  });
});

describe("ProjectPulseCard first load", () => {
  it("renders the header at once and holds the body empty until the skeleton gate", () => {
    usePulseStore.setState({ pulses: new Map(), errors: new Map() });
    render(<ProjectPulseCard worktreeId="wt1" />);

    expect(usePulseStore.getState().isLoading("wt1")).toBe(true);
    expect(screen.getByRole("radiogroup", { name: "Activity range" })).toBeTruthy();
    expect(document.querySelector("[data-skeleton-bone]")).toBeNull();
    expect(screen.queryByText(/new repository/i)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(document.querySelector("[data-skeleton-bone]")).not.toBeNull();
  });
});

describe("ProjectPulseCard background refresh", () => {
  it("shows no spinner and announces nothing for a quick refresh with unchanged data", async () => {
    const request = deferred<unknown>();
    dispatchMock.mockReturnValueOnce(request.promise);
    render(<ProjectPulseCard worktreeId="wt1" />);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(usePulseStore.getState().isLoading("wt1")).toBe(true);
    expect(refreshIconSpins()).toBe(false);
    expect(document.querySelector(".pulse-card-header .animate-spin")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(refreshIconSpins()).toBe(false);

    await settle(request.resolve, makePulse(60, { generatedAt: Date.now() + 1 }));

    expect(usePulseStore.getState().isLoading("wt1")).toBe(false);
    expect(liveRegionText()).toBe("");
  });

  it("shows the refresh spinner once a background refresh outlasts the gate", async () => {
    const request = deferred<unknown>();
    dispatchMock.mockReturnValueOnce(request.promise);
    render(<ProjectPulseCard worktreeId="wt1" />);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(refreshIconSpins()).toBe(true);

    await settle(request.resolve, makePulse(60));
  });

  it("announces an update when the refreshed data changed", async () => {
    const request = deferred<unknown>();
    dispatchMock.mockReturnValueOnce(request.promise);
    render(<ProjectPulseCard worktreeId="wt1" />);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle(request.resolve, makePulse(60, { commitsInRange: 3 }));

    expect(liveRegionText()).toBe("Pulse data updated");
  });

  it("announces nothing when the card moves to another worktree mid-refresh", () => {
    usePulseStore.setState({
      pulses: new Map([
        ["wt1", makePulse(60)],
        ["wt2", makePulse(60, { worktreeId: "wt2", commitsInRange: 9 })],
      ]),
      errors: new Map([
        ["wt1", null],
        ["wt2", null],
      ]),
    });
    const { rerender } = render(<ProjectPulseCard worktreeId="wt1" />);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    rerender(<ProjectPulseCard worktreeId="wt2" />);

    expect(liveRegionText()).toBe("");
  });

  it("keeps the live region outside any aria-busy ancestor while loading", () => {
    dispatchMock.mockReturnValueOnce(new Promise(() => {}));
    render(<ProjectPulseCard worktreeId="wt1" />);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByRole("status").closest('[aria-busy="true"]')).toBeNull();
  });
});

describe("ProjectPulseCard refresh button", () => {
  it("spins at once when the user asks for a refresh", () => {
    dispatchMock.mockReturnValueOnce(new Promise(() => {}));
    render(<ProjectPulseCard worktreeId="wt1" />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(refreshIconSpins()).toBe(true);
  });

  it("names itself in a tooltip on keyboard focus", async () => {
    render(<ProjectPulseCard worktreeId="wt1" />);

    const button = screen.getByRole("button", { name: "Refresh" });
    fireEvent.focus(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toBe("Refresh");
  });
});
