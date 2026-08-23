// @vitest-environment jsdom
/**
 * ProjectResourceBadge — visibility- and cache-aware polling.
 *
 * Issue #6212: the 10s badge poll must pause while the project view is hidden
 * so we don't burn renderer CPU on inactive projects. The 4s popover sub-poll
 * is already gated on `open` and is intentionally untested here.
 *
 * Issue #11925: `document.hidden` alone can't see a cached project view — main
 * caches with `removeChildView` + `setVisible(false)`, neither of which flips
 * page visibility, so the #6212 gate was dead code in exactly the case it was
 * written for. The poll is now gated on both signals, AND'd: a minimized window
 * and a cached view suppress it independently. The same issue took the absolute
 * memory figure and trend arrow off the collapsed trigger, so the trigger now
 * carries only the state dot and the running-project count.
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

  async function advance(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("does not call getAll when mounted while hidden", async () => {
    visibilityState = "hidden";

    render(<ProjectResourceBadge />);

    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

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
    expect(mockGetAppMetrics).not.toHaveBeenCalled();
  });

  it("stops polling when document becomes hidden after mount", async () => {
    render(<ProjectResourceBadge />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const callsBeforeHide = mockGetAll.mock.calls.length;
    expect(callsBeforeHide).toBeGreaterThanOrEqual(1);

    await act(async () => {
      fireVisibilityChange("hidden");
    });

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    // No additional polls while hidden.
    expect(mockGetAll.mock.calls.length).toBe(callsBeforeHide);
  });

  it("immediately fetches and resumes polling on visibility restore", async () => {
    visibilityState = "hidden";

    render(<ProjectResourceBadge />);

    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(mockGetAll).not.toHaveBeenCalled();

    await act(async () => {
      fireVisibilityChange("visible");
      await Promise.resolve();
      await Promise.resolve();
    });
    // Immediate fetch on restore.
    expect(mockGetAll.mock.calls.length).toBeGreaterThanOrEqual(1);
    const callsAfterRestore = mockGetAll.mock.calls.length;

    // Polling resumes.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(mockGetAll.mock.calls.length).toBeGreaterThan(callsAfterRestore);
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
  });

  it("stops polling when the project view becomes cached", async () => {
    render(<ProjectResourceBadge />);

    await flush();
    const callsBeforeCache = mockGetAll.mock.calls.length;
    const metricCallsBeforeCache = mockGetAppMetrics.mock.calls.length;
    expect(callsBeforeCache).toBeGreaterThanOrEqual(1);

    await act(async () => {
      emitCached();
    });
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

    mockGetAll.mockClear();
    mockGetAppMetrics.mockClear();
    await advance(10_000);

    // One interval, so exactly one poll per period.
    expect(mockGetAll).toHaveBeenCalledTimes(1);
    expect(mockGetAppMetrics).toHaveBeenCalledTimes(1);
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

    // Reactivated, but the window is still hidden — still no polling.
    await act(async () => {
      emitWarmActivated();
    });
    await advance(30_000);
    expect(mockGetAll).not.toHaveBeenCalled();

    // Both gates clear.
    await act(async () => {
      fireVisibilityChange("visible");
    });
    await flush();
    expect(mockGetAll.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps one interval across a StrictMode double mount", async () => {
    render(
      <StrictMode>
        <ProjectResourceBadge />
      </StrictMode>
    );
    await flush();

    mockGetAll.mockClear();
    await advance(10_000);

    // A leaked interval from the discarded first mount would double this.
    expect(mockGetAll).toHaveBeenCalledTimes(1);
  });

  it("probes hardware info once at mount to scale thresholds to the machine", async () => {
    render(<ProjectResourceBadge />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockGetHardwareInfo).toHaveBeenCalledTimes(1);
  });

  it("does not crash polling when hardware info probe rejects", async () => {
    mockGetHardwareInfo.mockRejectedValue(new Error("no hw"));

    render(<ProjectResourceBadge />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Badge still polls stats using the fallback thresholds.
    expect(mockGetAll.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("renders only the running-project count on the collapsed trigger", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "p1", name: "Proj One" })]);
    statsStoreState.stats = { p1: { processCount: 1 } };
    mockGetAppMetrics.mockResolvedValue({ totalMemoryMB: 290 });

    const { container } = render(<ProjectResourceBadge />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The reading is still collected — it drives the dot's state and the
    // popover — but the trigger deliberately withholds it. Summed working set
    // double-counts shared pages, so it isn't a footprint figure to lead with.
    const trigger = container.querySelector("button");
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toBe("1 project active");
  });

  it("suppresses the value (stays hidden) when metrics are unavailable", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "p1", name: "Proj One" })]);
    statsStoreState.stats = { p1: { processCount: 1 } };
    mockGetAppMetrics.mockResolvedValue({ totalMemoryMB: 0, unavailable: true });

    const { container } = render(<ProjectResourceBadge />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

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

    unmount();
    mockGetAll.mockClear();

    await act(async () => {
      emitCached();
      emitWarmActivated();
      emitRevealed();
    });
    await advance(30_000);

    expect(mockGetAll).not.toHaveBeenCalled();
  });
});
