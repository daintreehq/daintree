// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProjectPulse, PulseRangeDays } from "@shared/types";
import {
  UI_DOHERTY_THRESHOLD,
  UI_SKELETON_FLOOR_MS,
  UI_SKELETON_GATE_MS,
  UI_SPIN_CYCLE_MS,
} from "@/lib/animationUtils";

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

// The store's first retry after a failed fetch.
const FIRST_RETRY_MS = 2000;

function makePulse(rangeDays: PulseRangeDays, overrides: Partial<ProjectPulse> = {}): ProjectPulse {
  return {
    worktreeId: "wt1",
    worktreePath: "/repo",
    branch: "main",
    mainBranch: "main",
    rangeDays,
    generatedAt: Date.now(),
    heatmap: [
      { date: "2026-11-11", count: 0, level: 0 },
      { date: "2026-11-12", count: 2, level: 2 },
    ],
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

function nextRequest() {
  const request = deferred<unknown>();
  dispatchMock.mockReturnValueOnce(request.promise);
  return request;
}

async function answer(request: { resolve: (value: unknown) => void }, pulse: ProjectPulse) {
  await act(async () => {
    request.resolve({ ok: true, result: pulse });
  });
}

async function fail(request: { resolve: (value: unknown) => void }) {
  await act(async () => {
    request.resolve({ ok: false, error: { message: "boom" } });
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function seed(pulse: ProjectPulse | null) {
  usePulseStore.setState({
    pulses: pulse ? new Map([["wt1", pulse]]) : new Map(),
    loading: new Map(),
    errors: pulse ? new Map([["wt1", null]]) : new Map(),
    rangeDays: pulse?.rangeDays ?? 60,
    requestIds: new Map(),
    retryCount: new Map(),
    lastRetryTimestamp: new Map(),
    retryTimers: new Map(),
  });
}

function focusProbe() {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

// The card's own polite region comes first; the error state's "Retrying"
// status sits inside the body after it.
function liveRegionText() {
  return screen.getAllByRole("status")[0].textContent ?? "";
}

function refreshIconSpins() {
  const button = screen.getByRole("button", { name: "Refresh" });
  return button.querySelector(".animate-spin") !== null;
}

function hasSkeleton() {
  return document.querySelector("[data-skeleton-bone]") !== null;
}

beforeEach(() => {
  vi.useFakeTimers();
  dispatchMock.mockReset();
  dispatchMock.mockReturnValue(new Promise(() => {}));
  seed(makePulse(60));
});

// Unmount before touching timers, and cancel store retries rather than running
// them, so nothing fires against a mounted card outside act or leaks into real
// time after the fake clock is gone.
afterEach(() => {
  cleanup();
  usePulseStore.getState().invalidateAll();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("ProjectPulseCard range change", () => {
  it("keeps the range control mounted and focused while the new range loads", async () => {
    const request = nextRequest();
    render(<ProjectPulseCard worktreeId="wt1" />);
    const group = screen.getByRole("radiogroup", { name: "Activity range" });

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

    // Past both gates: the last snapshot stays up rather than a skeleton.
    advance(UI_DOHERTY_THRESHOLD + UI_SKELETON_FLOOR_MS);
    expect(hasSkeleton()).toBe(false);
    expect(screen.getByTestId("pulse-heatmap").getAttribute("data-range")).toBe("60");
    expect(document.activeElement).toBe(oneTwenty);

    await answer(request, makePulse(120));

    expect(screen.getByTestId("pulse-heatmap").getAttribute("data-range")).toBe("120");
    expect(screen.getByRole("radiogroup", { name: "Activity range" })).toBe(group);
    expect(document.activeElement).toBe(oneTwenty);
  });

  it("keeps the range control focused when the new range fails and retries", async () => {
    const request = nextRequest();
    render(<ProjectPulseCard worktreeId="wt1" />);
    const group = screen.getByRole("radiogroup", { name: "Activity range" });

    const sixty = screen.getByRole("radio", { name: "60 days" });
    sixty.focus();
    fireEvent.keyDown(sixty, { key: "ArrowRight" });
    const oneTwenty = screen.getByRole("radio", { name: "120 days" });
    await fail(request);

    expect(screen.getByRole("alert").textContent).toContain("Unable to load activity data");
    expect(screen.queryByTestId("pulse-heatmap")).toBeNull();
    expect(document.activeElement).toBe(oneTwenty);

    // The store's retry runs with no snapshot: the body shows its skeleton,
    // the header with the user's focus stays put.
    advance(FIRST_RETRY_MS);
    expect(usePulseStore.getState().isLoading("wt1")).toBe(true);
    advance(UI_SKELETON_GATE_MS);
    expect(hasSkeleton()).toBe(true);
    expect(screen.getByRole("radiogroup", { name: "Activity range" })).toBe(group);
    expect(document.activeElement).toBe(oneTwenty);
  });
});

describe("ProjectPulseCard shell", () => {
  it("keeps one shell and header through loading, error, no-commits and data", async () => {
    seed(null);
    const first = nextRequest();
    const { container } = render(<ProjectPulseCard worktreeId="wt1" />);
    const shell = container.firstElementChild;
    const group = screen.getByRole("radiogroup", { name: "Activity range" });
    const stillMounted = () => {
      expect(container.firstElementChild).toBe(shell);
      expect(screen.getByRole("radiogroup", { name: "Activity range" })).toBe(group);
    };

    advance(UI_SKELETON_GATE_MS);
    expect(hasSkeleton()).toBe(true);
    stillMounted();

    await fail(first);
    advance(UI_SKELETON_FLOOR_MS);
    expect(screen.getByRole("alert")).toBeTruthy();
    stillMounted();

    act(() => {
      usePulseStore.getState().clearRetryTimer("wt1");
      usePulseStore.setState({ errors: new Map([["wt1", null]]) });
    });
    expect(screen.getByText(/new repository/i)).toBeTruthy();
    stillMounted();

    act(() => {
      usePulseStore.setState({ pulses: new Map([["wt1", makePulse(60)]]) });
    });
    expect(screen.getByTestId("pulse-heatmap")).toBeTruthy();
    stillMounted();
  });
});

describe("ProjectPulseCard first load", () => {
  it("renders the header at once and holds the body empty until the skeleton gate", () => {
    seed(null);
    render(<ProjectPulseCard worktreeId="wt1" />);

    expect(usePulseStore.getState().isLoading("wt1")).toBe(true);
    expect(screen.getByRole("radiogroup", { name: "Activity range" })).toBeTruthy();
    expect(hasSkeleton()).toBe(false);
    expect(screen.queryByText(/new repository/i)).toBeNull();

    advance(UI_SKELETON_GATE_MS - 1);
    expect(hasSkeleton()).toBe(false);
    advance(1);
    expect(hasSkeleton()).toBe(true);
  });

  it("never shows the skeleton when the first answer beats the gate", async () => {
    seed(null);
    const request = nextRequest();
    render(<ProjectPulseCard worktreeId="wt1" />);

    advance(UI_SKELETON_GATE_MS / 2);
    await answer(request, makePulse(60));
    advance(UI_SKELETON_GATE_MS + UI_SKELETON_FLOOR_MS);

    expect(hasSkeleton()).toBe(false);
    expect(screen.getByTestId("pulse-heatmap")).toBeTruthy();
  });

  it("holds the skeleton for its floor, then opens the calendar at the newest week", async () => {
    const scrollLeft = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft");
    const scrollWidth = Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth");
    const setScrollLeft = vi.fn();
    Object.defineProperty(Element.prototype, "scrollLeft", {
      configurable: true,
      get: () => 0,
      set: setScrollLeft,
    });
    Object.defineProperty(Element.prototype, "scrollWidth", { configurable: true, get: () => 640 });
    try {
      seed(null);
      const request = nextRequest();
      render(<ProjectPulseCard worktreeId="wt1" />);

      advance(UI_SKELETON_GATE_MS);
      expect(hasSkeleton()).toBe(true);
      await answer(request, makePulse(60));
      expect(hasSkeleton()).toBe(true);
      expect(screen.queryByTestId("pulse-heatmap")).toBeNull();

      advance(UI_SKELETON_FLOOR_MS);
      expect(hasSkeleton()).toBe(false);
      expect(screen.getByTestId("pulse-heatmap")).toBeTruthy();
      expect(setScrollLeft).toHaveBeenLastCalledWith(640);
    } finally {
      if (scrollLeft) Object.defineProperty(Element.prototype, "scrollLeft", scrollLeft);
      if (scrollWidth) Object.defineProperty(Element.prototype, "scrollWidth", scrollWidth);
    }
  });

  it("announces nothing when a slow first load lands", async () => {
    seed(null);
    const request = nextRequest();
    render(<ProjectPulseCard worktreeId="wt1" />);

    advance(UI_DOHERTY_THRESHOLD + UI_SKELETON_FLOOR_MS);
    await answer(request, makePulse(60));
    advance(UI_SKELETON_FLOOR_MS);

    expect(screen.getByTestId("pulse-heatmap")).toBeTruthy();
    expect(liveRegionText()).toBe("");
  });
});

describe("ProjectPulseCard background refresh", () => {
  it("shows no spinner and announces nothing for a quick refresh with unchanged data", async () => {
    const request = nextRequest();
    render(<ProjectPulseCard worktreeId="wt1" />);

    focusProbe();
    expect(usePulseStore.getState().isLoading("wt1")).toBe(true);
    expect(refreshIconSpins()).toBe(false);
    expect(document.querySelector(".pulse-card-header .animate-spin")).toBeNull();
    expect(liveRegionText()).toBe("");

    advance(UI_DOHERTY_THRESHOLD - 1);
    expect(refreshIconSpins()).toBe(false);
    expect(liveRegionText()).toBe("");

    // A fresh object with only `generatedAt` moved, as the cached path returns.
    await answer(request, makePulse(60, { generatedAt: Date.now() + 1 }));

    expect(usePulseStore.getState().isLoading("wt1")).toBe(false);
    expect(liveRegionText()).toBe("");
  });

  it("spins and says it is refreshing once a refresh outlasts the gate, then goes quiet", async () => {
    const request = nextRequest();
    render(<ProjectPulseCard worktreeId="wt1" />);

    focusProbe();
    advance(UI_DOHERTY_THRESHOLD - 1);
    expect(refreshIconSpins()).toBe(false);
    advance(1);
    expect(refreshIconSpins()).toBe(true);
    expect(liveRegionText()).toBe("Refreshing pulse data");

    await answer(request, makePulse(60, { generatedAt: Date.now() + 1 }));
    expect(liveRegionText()).toBe("");
  });

  it("clears the refreshing announcement when the refresh fails", async () => {
    const request = nextRequest();
    render(<ProjectPulseCard worktreeId="wt1" />);

    focusProbe();
    advance(UI_DOHERTY_THRESHOLD);
    expect(liveRegionText()).toBe("Refreshing pulse data");

    await fail(request);
    expect(screen.getByTestId("pulse-heatmap")).toBeTruthy();
    expect(liveRegionText()).toBe("");
  });

  it("announces an update when the refreshed totals changed", async () => {
    const request = nextRequest();
    render(<ProjectPulseCard worktreeId="wt1" />);

    focusProbe();
    await answer(request, makePulse(60, { commitsInRange: 3 }));

    expect(liveRegionText()).toBe("Pulse data updated");
  });

  it("announces an update when activity moved between days with the same totals", async () => {
    const request = nextRequest();
    render(<ProjectPulseCard worktreeId="wt1" />);

    focusProbe();
    await answer(
      request,
      makePulse(60, {
        heatmap: [
          { date: "2026-11-11", count: 2, level: 2 },
          { date: "2026-11-12", count: 0, level: 0 },
        ],
      })
    );

    expect(liveRegionText()).toBe("Pulse data updated");
  });

  it("drops a refreshing announcement when the card moves to another worktree", () => {
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

    focusProbe();
    advance(UI_DOHERTY_THRESHOLD);
    expect(liveRegionText()).toBe("Refreshing pulse data");

    rerender(<ProjectPulseCard worktreeId="wt2" />);

    expect(liveRegionText()).toBe("");
  });

  it("marks only the body busy, leaving the live region and header outside it", async () => {
    const request = nextRequest();
    render(<ProjectPulseCard worktreeId="wt1" />);

    focusProbe();

    expect(screen.getByTestId("pulse-heatmap").closest('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getAllByRole("status")[0].closest('[aria-busy="true"]')).toBeNull();
    expect(
      screen.getByRole("radiogroup", { name: "Activity range" }).closest('[aria-busy="true"]')
    ).toBeNull();

    await answer(request, makePulse(60));
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

describe("ProjectPulseCard refresh button", () => {
  it("spins at once when the user asks for a refresh", () => {
    render(<ProjectPulseCard worktreeId="wt1" />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(refreshIconSpins()).toBe(true);
  });

  it("waits out the gate again for a background refresh after a manual one", async () => {
    const manual = nextRequest();
    render(<ProjectPulseCard worktreeId="wt1" />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await answer(manual, makePulse(60));
    // Past the spin's finishing turn.
    advance(UI_SPIN_CYCLE_MS);
    expect(refreshIconSpins()).toBe(false);

    nextRequest();
    focusProbe();
    expect(usePulseStore.getState().isLoading("wt1")).toBe(true);
    expect(refreshIconSpins()).toBe(false);
  });

  it("names itself in a tooltip on keyboard focus", async () => {
    render(<ProjectPulseCard worktreeId="wt1" />);

    const button = screen.getByRole("button", { name: "Refresh" });
    act(() => {
      button.focus();
    });
    expect(document.activeElement).toBe(button);
    fireEvent.focus(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toBe("Refresh");
  });
});
