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

// `vi.hoisted` because `vi.mock`'s factory is lifted above every const in the
// file — a plain top-level binding is still in its temporal dead zone when the
// factory runs, and the whole suite fails to collect.
const statsStoreState = vi.hoisted(() => ({
  stats: {} as Record<string, { processCount: number; activeAgentCount?: number }>,
}));
// The badge reads this both ways: `getState()` inside the poll for the project
// count, and as a hook selector for live agent activity.
vi.mock("@/store/projectStatsStore", () => {
  const useProjectStatsStore = (selector: (s: typeof statsStoreState) => unknown) =>
    selector(statsStoreState);
  useProjectStatsStore.getState = () => statsStoreState;
  return { useProjectStatsStore };
});

// Controlled-popover stub: `open` is mirrored onto the wrapper so tests can see
// it, and any click inside opens it the way the real trigger would.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div data-popover-open={open ? "true" : "false"} onClickCapture={() => onOpenChange?.(true)}>
      {children}
    </div>
  ),
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
    const survivor = makeProject({ id: "a", name: "A" });
    const stalled = [
      survivor,
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
    mockGetAll.mockReturnValueOnce(stalledFetch).mockResolvedValue([survivor]);

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

  it("keeps counting projects when the memory read fails, without inventing a figure", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "p1", name: "Proj One" })]);
    statsStoreState.stats = { p1: { processCount: 1 } };
    mockGetAppMetrics.mockResolvedValue({ totalMemoryMB: 0, unavailable: true });

    const { container } = render(<ProjectResourceBadge />);

    await flush();

    // The count comes from the stats store, not from main's process read, so
    // a failed read must not freeze or hide it — but it must not produce a
    // memory figure either, and a zero reading must not trip the warning.
    expect(container.querySelector("[data-status-readout]")?.textContent).toBe("1 project active");
    expect(container.textContent ?? "").not.toMatch(/\d\s*MB/);
    expect(container.querySelector('[data-testid="sidebar-status-items"]')).toBeNull();
  });

  it("keeps counting projects when the memory read rejects outright", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "p1", name: "Proj One" })]);
    statsStoreState.stats = { p1: { processCount: 1 } };
    mockGetAppMetrics.mockRejectedValue(new Error("metrics ipc down"));

    const { container } = render(<ProjectResourceBadge />);
    await flush();

    expect(container.querySelector("[data-status-readout]")?.textContent).toBe("1 project active");
  });

  it("keeps whatever the footer pins beside the readout before the first read lands", async () => {
    mockGetAll.mockReturnValue(new Promise(() => {}));
    mockGetAppMetrics.mockReturnValue(new Promise(() => {}));
    statsStoreState.stats = {};

    const { container } = render(
      <ProjectResourceBadge trailing={<button type="button">Run command</button>} />
    );
    await flush();

    // Run command has nothing to do with whether the metrics read has
    // landed; it used to vanish with the readout.
    expect(container.querySelector("[data-status-readout]")).toBeNull();
    expect(container.textContent).toContain("Run command");
  });

  it("keeps the readout in place with nothing running, rather than vanishing", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "p1", name: "Proj One" })]);
    statsStoreState.stats = {};

    const { container } = render(<ProjectResourceBadge />);
    await flush();

    // A row that disappears when idle makes "idle" and "this strip isn't here"
    // the same picture, and idle is half the question the footer answers.
    const readout = container.querySelector("[data-status-readout]");
    expect(readout).not.toBeNull();
    expect(readout?.textContent).toBe("Idle");
  });

  it("marks working and idle differently, by more than colour", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "p1", name: "Proj One" })]);
    statsStoreState.stats = { p1: { processCount: 1, activeAgentCount: 1 } };

    const first = render(<ProjectResourceBadge />);
    await flush();
    const workingMark = first.container.querySelector(".status-mark")?.className ?? "";
    first.unmount();

    statsStoreState.stats = { p1: { processCount: 1, activeAgentCount: 0 } };
    const second = render(<ProjectResourceBadge />);
    await flush();
    const idleMark = second.container.querySelector(".status-mark")?.className ?? "";

    // The rule, not the palette: the two states must be distinguishable, and
    // one of them must differ in shape so the distinction survives WCAG 1.4.1
    // and a monochrome or forced-colors rendering.
    expect(workingMark).not.toBe(idleMark);
    expect(/\bborder\b/.test(workingMark)).not.toBe(/\bborder\b/.test(idleMark));
  });

  it("sits its mark in the footer's shared glyph column", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "p1", name: "Proj One" })]);
    statsStoreState.stats = { p1: { processCount: 1, activeAgentCount: 1 } };

    const { container } = render(<ProjectResourceBadge />);
    await flush();

    // The footer's other rows share this leading column; a mark sized by
    // itself put this label at a different x from Run command's (#12587).
    const readout = container.querySelector("[data-status-readout]");
    const slots = readout?.querySelectorAll('[data-sidebar-footer-slot="glyph"]') ?? [];
    expect(slots).toHaveLength(1);
    // The forced-colors hooks stay on the mark itself, not on its column.
    const mark = slots[0]!.querySelector(".status-mark");
    expect(mark?.getAttribute("data-working")).toBe("true");
    expect(slots[0]!.nextElementSibling?.textContent).toBe("1 project active");
  });

  it("reads work from agent activity, not from processes being up", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "p1", name: "Proj One" })]);
    // Processes are up but no agent is working — a shell sitting at a prompt.
    statsStoreState.stats = { p1: { processCount: 4, activeAgentCount: 0 } };

    const { container } = render(<ProjectResourceBadge />);
    await flush();

    const mark = container.querySelector(".status-mark");
    expect(mark?.getAttribute("data-working")).toBe("false");
    // ...and the count is still reported, because it is a separate fact.
    expect(container.querySelector("[data-status-readout]")?.textContent).toBe("1 project active");
  });

  it("spells the working state out for assistive technology", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "p1", name: "Proj One" })]);
    statsStoreState.stats = { p1: { processCount: 1, activeAgentCount: 2 } };

    const { container } = render(<ProjectResourceBadge />);
    await flush();

    // The mark is the only thing carrying working/idle visually, so a run whose
    // project count never changes would otherwise flip state in silence.
    const live = container.querySelector('[role="status"]');
    expect(live?.textContent).toContain("Working");
    expect(container.querySelector(".status-mark")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("announces the count without wrapping the trigger button in a live region", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "p1", name: "Proj One" })]);
    statsStoreState.stats = { p1: { processCount: 1 } };

    const { container } = render(<ProjectResourceBadge />);
    await flush();

    const live = container.querySelector('[role="status"]');
    expect(live?.textContent).toContain("1 project active");
    // A live region containing a control re-announces the whole strip every
    // time that control is pressed.
    expect(live?.querySelector("button")).toBeNull();
    // And not inside one either — a live region in a control's own subtree.
    expect(live?.closest("button")).toBeNull();
  });

  it("raises a memory exception only once the threshold trips, outside the trigger", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "p1", name: "Proj One" })]);
    statsStoreState.stats = { p1: { processCount: 1 } };
    mockGetHardwareInfo.mockResolvedValue({ totalMemoryBytes: 16 * 1024 ** 3, logicalCpuCount: 8 });
    mockGetAppMetrics.mockResolvedValue({ totalMemoryMB: 100 });

    const { container } = render(<ProjectResourceBadge />);
    await flush();
    expect(container.textContent ?? "").not.toContain("High app memory");

    // 0.33 of 16GB is ~5.4GB; 9GB is past it.
    mockGetAppMetrics.mockResolvedValue({ totalMemoryMB: 9_000 });
    await advance(10_000);

    expect(container.textContent ?? "").toContain("High app memory");
    const trigger = container.querySelector("[data-status-readout]");
    expect(trigger?.textContent ?? "").not.toContain("High app memory");
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
