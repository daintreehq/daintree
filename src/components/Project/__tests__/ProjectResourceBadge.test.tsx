// @vitest-environment jsdom
/**
 * ProjectResourceBadge — visibility- and cache-aware polling.
 *
 * Issue #6212: the 10s badge poll must pause while the project view is hidden
 * so we don't burn renderer CPU on inactive projects. The 4s popover sub-poll
 * is gated on `open` and is covered in ProjectResourceBadge.popover.test.tsx.
 *
 * Issue #11925: `document.hidden` alone can't see a cached project view — main
 * caches with `removeChildView` + `setVisible(false)`, neither of which flips
 * page visibility, so the #6212 gate was dead code in exactly the case it was
 * written for. The poll is now gated on both signals, AND'd: a minimized window
 * and a cached view suppress it independently. The same issue took the absolute
 * memory figure and trend arrow off the collapsed trigger, so the trigger now
 * carries only the state dot and the running-project count.
 *
 * Timer counts are asserted alongside call counts throughout: IPC counts alone
 * can't distinguish "one interval" from "three intervals whose extra callbacks
 * were swallowed by the in-flight guard".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { act, StrictMode } from "react";

vi.mock("@/clients", () => ({
  projectClient: {
    getAll: vi.fn(),
    getBulkStats: vi.fn(),
  },
  systemClient: {
    getAppMetrics: vi.fn(),
    getHardwareInfo: vi.fn(),
    getProcessMetrics: vi.fn(),
    getHeapStats: vi.fn(),
    getDiagnosticsInfo: vi.fn(),
  },
}));

const statsStoreState: { stats: Record<string, { processCount: number }> } = { stats: {} };
vi.mock("@/store/projectStatsStore", () => ({
  useProjectStatsStore: {
    getState: () => statsStoreState,
  },
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: () => null,
}));

import { projectClient, systemClient } from "@/clients";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";
import type { Project } from "@shared/types";
import { ProjectResourceBadge } from "../ProjectResourceBadge";

const mockGetAll = vi.mocked(projectClient.getAll);
const mockGetAppMetrics = vi.mocked(systemClient.getAppMetrics);
const mockGetHardwareInfo = vi.mocked(systemClient.getHardwareInfo);

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "Test Project",
    path: "/tmp/test",
    emoji: "🚀",
    color: "blue",
    status: "active",
    lastOpened: 0,
    ...overrides,
  };
}

describe("ProjectResourceBadge — visibility- and cache-aware polling", () => {
  let originalHidden: boolean;
  let visibilityState: DocumentVisibilityState;
  let visibilityListeners: Array<() => void>;
  // Drives the real `viewCacheState` singleton through its preload boundary
  // rather than mocking the module: the seed latch, the "state updates before
  // listeners fire" ordering, and the unsubscribe are all part of what's under
  // test here. Mirrors TerminalReconciliationWatchdog.test.ts.
  let latchedCached: boolean;
  let cachedHandlers: Set<() => void>;
  let warmHandlers: Set<() => void>;
  let revealedHandlers: Set<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    visibilityListeners = [];
    originalHidden = document.hidden;
    visibilityState = "visible";

    Object.defineProperty(document, "hidden", {
      get: () => visibilityState === "hidden",
      configurable: true,
    });
    Object.defineProperty(document, "visibilityState", {
      get: () => visibilityState,
      configurable: true,
    });

    const origAdd = document.addEventListener.bind(document);
    const origRemove = document.removeEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, handler, options) => {
      if (type === "visibilitychange") {
        visibilityListeners.push(handler as () => void);
      }
      return origAdd(type, handler, options);
    });
    vi.spyOn(document, "removeEventListener").mockImplementation((type, handler, options) => {
      if (type === "visibilitychange") {
        visibilityListeners = visibilityListeners.filter((l) => l !== handler);
      }
      return origRemove(type, handler, options);
    });

    latchedCached = false;
    cachedHandlers = new Set();
    warmHandlers = new Set();
    revealedHandlers = new Set();
    vi.stubGlobal("electron", {
      app: {
        onViewCached: (cb: () => void) => {
          cachedHandlers.add(cb);
          return () => cachedHandlers.delete(cb);
        },
        onViewWarmActivated: (cb: () => void) => {
          warmHandlers.add(cb);
          return () => warmHandlers.delete(cb);
        },
        onViewRevealed: (cb: () => void) => {
          revealedHandlers.add(cb);
          return () => revealedHandlers.delete(cb);
        },
        // Preload's latch. Setting this before render reproduces the switch
        // storm where the view was cached before this module ever evaluated,
        // so no "cached" phase is ever delivered.
        isViewCached: () => latchedCached,
      },
    });
    // The singleton arms on first use and stays armed for the module's life,
    // so an earlier test's arming would otherwise bind to a dead bridge.
    __resetProjectViewCacheStateForTests();

    mockGetAll.mockReset();
    mockGetAll.mockResolvedValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockResolvedValue({ totalMemoryMB: 100 });
    mockGetHardwareInfo.mockReset();
    mockGetHardwareInfo.mockResolvedValue({
      totalMemoryBytes: 8 * 1024 * 1024 * 1024,
      logicalCpuCount: 8,
    });
    statsStoreState.stats = {};
  });

  afterEach(() => {
    // Reset before unstubbing so the singleton's stored unsubscribes still
    // have a bridge to detach from.
    __resetProjectViewCacheStateForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(document, "hidden", {
      value: originalHidden,
      configurable: true,
      writable: true,
    });
  });

  function fireVisibilityChange(state: DocumentVisibilityState) {
    visibilityState = state;
    visibilityListeners.forEach((l) => l());
  }

  function emitCached() {
    latchedCached = true;
    Array.from(cachedHandlers).forEach((h) => h());
  }

  function emitWarmActivated() {
    latchedCached = false;
    Array.from(warmHandlers).forEach((h) => h());
  }

  function emitRevealed() {
    latchedCached = false;
    Array.from(revealedHandlers).forEach((h) => h());
  }

  /** Let the poll's `Promise.all` fan-out and the state writes behind it settle. */
  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  /**
   * Async advancement, deliberately: the sync variant fires every armed
   * interval before any microtask runs, so a duplicate interval's callback
   * would be swallowed by the in-flight guard and the extra timer would go
   * unnoticed.
   */
  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("does not call getAll when mounted while hidden", async () => {
    visibilityState = "hidden";

    render(<ProjectResourceBadge />);

    await flush();
    await advance(30_000);

    expect(mockGetAll).not.toHaveBeenCalled();
    expect(mockGetAppMetrics).not.toHaveBeenCalled();

    // A non-cached lifecycle phase must not override the visibility gate — the
    // two suppressions are AND'd, not alternatives.
    await act(async () => {
      emitWarmActivated();
      emitRevealed();
    });
    await advance(30_000);

    expect(mockGetAll).not.toHaveBeenCalled();

    // Positive control: the same lifecycle route the assertions above rely on
    // does start polling once the visibility gate opens, so "no calls" was a
    // real suppression and not dead wiring.
    visibilityState = "visible";
    await act(async () => {
      emitRevealed();
    });
    await flush();
    expect(mockGetAll).toHaveBeenCalledTimes(1);
  });

  it("stops polling when document becomes hidden after mount", async () => {
    render(<ProjectResourceBadge />);

    await flush();
    const callsBeforeHide = mockGetAll.mock.calls.length;
    expect(callsBeforeHide).toBeGreaterThanOrEqual(1);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      fireVisibilityChange("hidden");
    });
    expect(vi.getTimerCount()).toBe(0);

    await advance(30_000);

    // No additional polls while hidden.
    expect(mockGetAll.mock.calls.length).toBe(callsBeforeHide);
  });

  it("immediately fetches and resumes polling on visibility restore", async () => {
    visibilityState = "hidden";

    render(<ProjectResourceBadge />);

    await flush();
    await advance(15_000);
    expect(mockGetAll).not.toHaveBeenCalled();

    await act(async () => {
      fireVisibilityChange("visible");
    });
    await flush();
    // Immediate fetch on restore.
    expect(mockGetAll).toHaveBeenCalledTimes(1);

    // Polling resumes, at one poll per period.
    mockGetAll.mockClear();
    await advance(10_000);
    expect(mockGetAll).toHaveBeenCalledTimes(1);
  });

  it("does not poll when mounted while the project view is cached", async () => {
    latchedCached = true;

    render(<ProjectResourceBadge />);

    await flush();
    await advance(30_000);

    // The view reports visibilityState "visible" throughout — only the cache
    // signal can suppress this.
    expect(visibilityState).toBe("visible");
    expect(mockGetAll).not.toHaveBeenCalled();
    expect(mockGetAppMetrics).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // Positive control: the effect did mount and did subscribe — it was the
    // seeded cache latch suppressing it, not absent wiring.
    await act(async () => {
      emitWarmActivated();
    });
    await flush();
    expect(mockGetAll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops polling when the project view becomes cached", async () => {
    render(<ProjectResourceBadge />);

    await flush();
    const callsBeforeCache = mockGetAll.mock.calls.length;
    const metricCallsBeforeCache = mockGetAppMetrics.mock.calls.length;
    expect(callsBeforeCache).toBeGreaterThanOrEqual(1);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      emitCached();
    });

    // The interval is actually torn down, not merely short-circuited in its
    // body — a cached view should own no armed timer at all.
    expect(vi.getTimerCount()).toBe(0);

    await advance(30_000);
    expect(mockGetAll.mock.calls.length).toBe(callsBeforeCache);
    expect(mockGetAppMetrics.mock.calls.length).toBe(metricCallsBeforeCache);
  });

  it("resumes once on warm activation and does not stack a second interval on reveal", async () => {
    latchedCached = true;

    render(<ProjectResourceBadge />);
    await flush();
    expect(mockGetAll).not.toHaveBeenCalled();

    // `revealed` normally follows `active`, and a superseded switch can deliver
    // `active` again — neither may start a second interval or a second fetch.
    await act(async () => {
      emitWarmActivated();
      emitRevealed();
      emitWarmActivated();
    });
    await flush();

    expect(mockGetAll).toHaveBeenCalledTimes(1);
    expect(mockGetAppMetrics).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    mockGetAll.mockClear();
    mockGetAppMetrics.mockClear();
    await advance(10_000);

    // One interval, so exactly one poll per period.
    expect(mockGetAll).toHaveBeenCalledTimes(1);
    expect(mockGetAppMetrics).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("resumes on reveal when warm activation was never observed", async () => {
    latchedCached = true;

    render(<ProjectResourceBadge />);
    await flush();
    expect(mockGetAll).not.toHaveBeenCalled();

    await act(async () => {
      emitRevealed();
    });
    await flush();

    expect(mockGetAll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    mockGetAll.mockClear();
    await advance(10_000);
    expect(mockGetAll).toHaveBeenCalledTimes(1);
  });

  it("stays paused until both the cache gate and the visibility gate clear", async () => {
    render(<ProjectResourceBadge />);
    await flush();
    expect(mockGetAll.mock.calls.length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      emitCached();
      fireVisibilityChange("hidden");
    });
    mockGetAll.mockClear();
    await advance(30_000);
    expect(mockGetAll).not.toHaveBeenCalled();

    // Visibility restored first, cache gate still closed. If the cache half
    // were broken this would resume here — which is exactly the pre-fix bug.
    await act(async () => {
      fireVisibilityChange("visible");
    });
    await advance(30_000);
    expect(mockGetAll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // Second gate clears.
    await act(async () => {
      emitWarmActivated();
    });
    await flush();
    expect(mockGetAll).toHaveBeenCalledTimes(1);
  });

  it("ignores an interval callback that was already queued when the view cached", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    render(<ProjectResourceBadge />);
    await flush();

    const armed = setIntervalSpy.mock.calls.find((call) => call[1] === 10_000);
    expect(armed).toBeDefined();
    const tick = armed![0] as () => void;
    // Released here, not in teardown: `restoreAllMocks` runs after
    // `useRealTimers`, so it would put this spy's original — an uninstalled
    // fake `setInterval` — back on the global.
    setIntervalSpy.mockRestore();

    // Positive control: this really is the live poll callback.
    mockGetAll.mockClear();
    await act(async () => {
      tick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockGetAll).toHaveBeenCalledTimes(1);

    await act(async () => {
      emitCached();
    });

    // clearInterval can't retract a callback the event loop already picked up,
    // so the body has to re-check the gates itself.
    mockGetAll.mockClear();
    await act(async () => {
      tick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockGetAll).not.toHaveBeenCalled();
  });

  it("refetches on resume and drops a poll left in flight across the pause", async () => {
    const stalled = [
      makeProject({ id: "a", name: "A" }),
      makeProject({ id: "b", name: "B" }),
      makeProject({ id: "c", name: "C" }),
    ];
    statsStoreState.stats = {
      a: { processCount: 1 },
      b: { processCount: 1 },
      c: { processCount: 1 },
    };

    let releaseStalled: (projects: Project[]) => void = () => {};
    const stalledFetch = new Promise<Project[]>((resolve) => {
      releaseStalled = resolve;
    });
    mockGetAll.mockReturnValueOnce(stalledFetch).mockResolvedValue([stalled[0]]);

    const { container } = render(<ProjectResourceBadge />);
    await flush();
    expect(mockGetAll).toHaveBeenCalledTimes(1);

    await act(async () => {
      emitCached();
    });
    await act(async () => {
      emitWarmActivated();
    });
    await flush();

    // The stranded request must not hold the resume refresh hostage for a whole
    // interval — the badge would otherwise show pre-pause numbers for 10s.
    expect(mockGetAll).toHaveBeenCalledTimes(2);
    expect(container.querySelector("button")?.textContent).toBe("1 project active");

    await act(async () => {
      releaseStalled(stalled);
    });
    await flush();

    // The pre-pause result lands last but is discarded: applying it would both
    // rewrite the count and seed the trend window the resume just cleared.
    expect(container.querySelector("button")?.textContent).toBe("1 project active");
  });

  it("keeps one interval across a StrictMode double mount", async () => {
    render(
      <StrictMode>
        <ProjectResourceBadge />
      </StrictMode>
    );
    await flush();

    // Precondition: the effect really did run twice (vitest.config.ts pins
    // NODE_ENV=development, so React double-invokes). If this drifts to one,
    // the assertion below stops testing double-mount cleanup.
    expect(mockGetAll).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    mockGetAll.mockClear();
    await advance(10_000);

    // A leaked interval from the discarded first mount would double this.
    expect(mockGetAll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("probes hardware info once at mount to scale thresholds to the machine", async () => {
    render(<ProjectResourceBadge />);

    await flush();

    expect(mockGetHardwareInfo).toHaveBeenCalledTimes(1);
  });

  it("does not crash polling when hardware info probe rejects", async () => {
    mockGetHardwareInfo.mockRejectedValue(new Error("no hw"));

    render(<ProjectResourceBadge />);

    await flush();

    // Badge still polls stats using the fallback thresholds.
    expect(mockGetAll.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("renders only the running-project count on the collapsed trigger", async () => {
    const projects = [
      makeProject({ id: "p1", name: "Proj One" }),
      makeProject({ id: "p2", name: "Proj Two" }),
    ];
    mockGetAll.mockResolvedValue(projects);
    statsStoreState.stats = { p1: { processCount: 1 }, p2: { processCount: 3 } };
    // A steadily rising series, so the trend the popover reports is "up" — the
    // condition under which the removed trigger arrow used to render.
    mockGetAppMetrics
      .mockResolvedValueOnce({ totalMemoryMB: 200 })
      .mockResolvedValueOnce({ totalMemoryMB: 400 })
      .mockResolvedValue({ totalMemoryMB: 600 });

    const { container } = render(<ProjectResourceBadge />);

    await flush();
    await advance(10_000);
    await advance(10_000);

    const trigger = container.querySelector("button");
    expect(trigger).not.toBeNull();
    // The reading is still collected — it drives the dot and the popover — but
    // the trigger withholds it: summed working set double-counts shared pages,
    // so it isn't a footprint figure to lead with.
    expect(trigger?.textContent).toContain(`${projects.length} projects active`);
    expect(trigger?.textContent).not.toMatch(/\d+\s*(MB|GB)/);
    expect(trigger?.textContent).not.toMatch(/[↑↓]/);
  });

  it("suppresses the value (stays hidden) when metrics are unavailable", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "p1", name: "Proj One" })]);
    statsStoreState.stats = { p1: { processCount: 1 } };
    mockGetAppMetrics.mockResolvedValue({ totalMemoryMB: 0, unavailable: true });

    const { container } = render(<ProjectResourceBadge />);

    await flush();

    // No misleading "0MB"; the badge withholds the reading entirely.
    expect(container.textContent ?? "").not.toContain("0MB");
    expect(container.textContent ?? "").not.toContain("project active");
  });

  it("removes visibility listener on unmount", () => {
    const { unmount } = render(<ProjectResourceBadge />);
    expect(visibilityListeners.length).toBeGreaterThan(0);

    unmount();
    expect(visibilityListeners.length).toBe(0);
  });

  it("stops polling and ignores lifecycle phases after unmount", async () => {
    const { unmount } = render(<ProjectResourceBadge />);
    await flush();

    // Positive control: the lifecycle route is live while mounted, so the
    // silence after unmount is an unsubscribe and not a broken bridge.
    await act(async () => {
      emitCached();
    });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      emitWarmActivated();
    });
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    mockGetAll.mockClear();

    await act(async () => {
      emitCached();
      emitWarmActivated();
      emitRevealed();
    });
    await advance(30_000);

    expect(mockGetAll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
