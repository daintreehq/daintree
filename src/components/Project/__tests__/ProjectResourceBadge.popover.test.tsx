// @vitest-environment jsdom
/**
 * ProjectResourceBadge — popover memory honesty.
 *
 * The popover must label its memory truthfully: workload totals and the
 * per-project split come from one composite snapshot, unavailable reads
 * preserve the last good value with an explicit note (never a fake 0), and
 * process-level detail stays folded until asked for.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";

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
    getMemorySnapshot: vi.fn(),
  },
}));

const statsStoreState: { stats: Record<string, { processCount: number }> } = { stats: {} };
// Callable as well as `getState`-able: the badge subscribes to this store for
// live agent activity and reads it imperatively inside the poll.
vi.mock("@/store/projectStatsStore", () => {
  const useProjectStatsStore = (selector: (s: typeof statsStoreState) => unknown) =>
    selector(statsStoreState);
  useProjectStatsStore.getState = () => statsStoreState;
  return { useProjectStatsStore };
});

// Controlled-popover stub: the component drives `open` through onOpenChange, so
// any click inside the wrapper opens it and the content always renders.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => <div onClickCapture={() => onOpenChange?.(true)}>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { projectClient, systemClient } from "@/clients";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";
import type { Project } from "@shared/types";
import type {
  CompositeMemorySnapshot,
  TerminalWorkloadSlice,
} from "@shared/types/memoryAccounting";
import type { ProcessMetricEntry } from "@shared/types/ipc/system";
import { ProjectResourceBadge } from "../ProjectResourceBadge";
import { _resetPluginTaskStoreForTest, usePluginTaskStore } from "@/store/pluginTaskStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";

// Load the deferred Radix primitives up front: the tooltips mount on them, and
// the fake timers these tests run under would otherwise stall the lazy load.
beforeAll(async () => {
  await primeRadix();
});

const mockGetAll = vi.mocked(projectClient.getAll);
const mockGetBulkStats = vi.mocked(projectClient.getBulkStats);
const mockGetAppMetrics = vi.mocked(systemClient.getAppMetrics);
const mockGetHardwareInfo = vi.mocked(systemClient.getHardwareInfo);
const mockGetProcessMetrics = vi.mocked(systemClient.getProcessMetrics);
const mockGetHeapStats = vi.mocked(systemClient.getHeapStats);
const mockGetDiagnosticsInfo = vi.mocked(systemClient.getDiagnosticsInfo);
const mockGetMemorySnapshot = vi.mocked(systemClient.getMemorySnapshot);

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Proj One",
    path: "/tmp/test",
    emoji: "🚀",
    color: "blue",
    status: "active",
    lastOpened: 0,
    ...overrides,
  };
}

function makeWorkloads(overrides: Partial<TerminalWorkloadSlice> = {}): TerminalWorkloadSlice {
  return {
    available: true,
    stale: false,
    ageMs: 2_000,
    sampledAt: Date.now() - 2_000,
    totalMemoryMb: 900,
    memorySource: "footprint",
    processCount: 6,
    terminalCount: 2,
    byProject: [],
    ...overrides,
  };
}

function makeMemorySnapshot(
  workloadOverrides: Partial<TerminalWorkloadSlice> = {}
): CompositeMemorySnapshot {
  return {
    timestamp: Date.now(),
    electron: {
      available: true,
      totalWorkingSetMb: 300,
      memorySource: "footprint",
      processCount: 4,
      sampledAt: Date.now(),
    },
    terminalWorkloads: makeWorkloads(workloadOverrides),
  };
}

async function renderOpenBadge(): Promise<HTMLElement> {
  // The app root supplies the TooltipProvider.
  const { container } = render(<ProjectResourceBadge />, { wrapper: TooltipProvider });
  // Flush the initial badge poll so the trigger renders.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const trigger = container.querySelector("button");
  expect(trigger).not.toBeNull();
  await act(async () => {
    fireEvent.click(trigger!);
  });
  // Flush the popover fetch fan-out.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

// Drives the real `viewCacheState` singleton through its preload boundary, the
// same way ProjectResourceBadge.test.tsx does.
let cachedHandlers: Set<() => void>;
let revealedHandlers: Set<() => void>;
let documentHidden = false;
let originalHidden: boolean;

function emitCached(): void {
  Array.from(cachedHandlers).forEach((h) => h());
}

function emitRevealed(): void {
  Array.from(revealedHandlers).forEach((h) => h());
}

/** Opens a trigger's tooltip by focusing it and returns what it says. */
async function tooltipTextOf(trigger: HTMLElement): Promise<string | null> {
  await act(async () => {
    fireEvent.focus(trigger);
  });
  // `hidden: true`: jsdom has no layout, and here the popper keeps its wrapper
  // at visibility:hidden (hideWhenDetached). The open tooltip's content is still
  // what's read.
  const text = screen.queryByRole("tooltip", { hidden: true })?.textContent ?? null;
  await act(async () => {
    fireEvent.blur(trigger);
  });
  return text;
}

/**
 * The label cell of the process row for `pid`, found by the tooltip that pairs
 * the label with its pid — the pid is only on offer there, never a native title.
 */
async function findProcessRowLabel(
  container: HTMLElement,
  pid: number
): Promise<{ label: HTMLElement; tooltip: string } | null> {
  const section = container.querySelector<HTMLElement>("#resource-diagnostics");
  if (!section) return null;
  for (const trigger of Array.from(section.querySelectorAll<HTMLElement>("[data-state]"))) {
    const tooltip = await tooltipTextOf(trigger);
    if (tooltip?.endsWith(`(${pid})`)) return { label: trigger, tooltip };
  }
  return null;
}

/** Unfolds the Diagnostics section, where the terminal buffer breakdown lives. */
async function openDiagnostics(container: HTMLElement): Promise<void> {
  const toggle = Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-controls") === "resource-diagnostics"
  );
  expect(toggle).toBeDefined();
  await act(async () => {
    fireEvent.click(toggle!);
  });
}

/** What a buffer row's label offers in its tooltip, or null when it offers none. */
async function bufferRowHint(breakdown: Element, label: string): Promise<string | null> {
  const trigger = Array.from(breakdown.querySelectorAll<HTMLElement>("span")).find(
    (el) => el.textContent === label
  );
  expect(trigger).toBeDefined();
  // A hint carries a reading a keyboard user needs, so it is a tab stop.
  if (trigger!.tabIndex !== 0) return null;
  return tooltipTextOf(trigger!);
}

function findMemoryRow(container: HTMLElement, value: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll("div")).find(
    (el) => el.children.length === 2 && el.children[1]?.textContent === value
  );
}

function setupDefaultMocks(): void {
  vi.useFakeTimers();
  cachedHandlers = new Set();
  revealedHandlers = new Set();
  documentHidden = false;
  originalHidden = document.hidden;
  Object.defineProperty(document, "hidden", {
    get: () => documentHidden,
    configurable: true,
  });
  vi.stubGlobal("electron", {
    app: {
      onViewCached: (cb: () => void) => {
        cachedHandlers.add(cb);
        return () => cachedHandlers.delete(cb);
      },
      onViewWarmActivated: () => () => {},
      onViewRevealed: (cb: () => void) => {
        revealedHandlers.add(cb);
        return () => revealedHandlers.delete(cb);
      },
      isViewCached: () => false,
    },
  });
  __resetProjectViewCacheStateForTests();
  mockGetAll.mockReset().mockResolvedValue([makeProject()]);
  mockGetBulkStats.mockReset();
  mockGetAppMetrics.mockReset().mockResolvedValue({ totalMemoryMB: 290 });
  mockGetHardwareInfo.mockReset().mockResolvedValue({
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    logicalCpuCount: 8,
  });
  mockGetProcessMetrics.mockReset().mockResolvedValue([]);
  mockGetHeapStats
    .mockReset()
    .mockResolvedValue({ usedMB: 100, limitMB: 200, percent: 50, externalMB: 10 });
  mockGetDiagnosticsInfo
    .mockReset()
    .mockResolvedValue({ uptimeSeconds: 60, eventLoopP99Ms: 10, systemAvailableMB: 4096 });
  mockGetMemorySnapshot.mockReset().mockResolvedValue(makeMemorySnapshot());
  statsStoreState.stats = { p1: { processCount: 1 } };
}

function restoreTimersAndMocks(): void {
  Object.defineProperty(document, "hidden", {
    value: originalHidden,
    configurable: true,
    writable: true,
  });
  // Reset before unstubbing so the singleton still has a bridge to detach from.
  __resetProjectViewCacheStateForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
}

describe("ProjectResourceBadge — popover memory honesty", () => {
  beforeEach(setupDefaultMocks);

  afterEach(restoreTimersAndMocks);

  it("labels measured app and workload memory from the composite snapshot", async () => {
    const container = await renderOpenBadge();

    // Asserted on meaning rather than the exact sentence: each figure names
    // what it measures, and the double-count is disclosed once, in words.
    const appRow = findMemoryRow(container, "300 MB");
    expect(appRow?.children[0]?.textContent?.toLowerCase()).toContain("daintree");
    const workloadRow = findMemoryRow(container, "900 MB");
    expect(workloadRow?.children[0]?.textContent?.toLowerCase()).toContain("terminal");
    expect(container.textContent?.toLowerCase()).toContain(
      "shared memory is counted in each process"
    );
  });

  it("leaves the high-memory warning to the pressure figure, not the snapshot total (#13637)", async () => {
    // 8 GB → critical at ~2.7 GB. The snapshot total counts the GPU process's
    // graphics footprint; the badge's pressure figure doesn't.
    const snapshot = makeMemorySnapshot();
    snapshot.electron.totalWorkingSetMb = 4_000;
    mockGetMemorySnapshot.mockResolvedValue(snapshot);
    mockGetAppMetrics.mockResolvedValue({ totalMemoryMB: 4_000, pressureMemoryMB: 500 });

    const container = await renderOpenBadge();

    expect(findMemoryRow(container, "3.9 GB")).toBeTruthy();
    expect(document.body.textContent).not.toContain("memory use is high");
  });

  it("warns in the popover once the pressure figure itself is high", async () => {
    mockGetAppMetrics.mockResolvedValue({ totalMemoryMB: 4_000, pressureMemoryMB: 3_000 });

    await renderOpenBadge();

    expect(document.body.textContent).toContain("memory use is high");
  });

  it("stops the popover poll when the project view is cached", async () => {
    await renderOpenBadge();
    const onOpen = mockGetMemorySnapshot.mock.calls.length;
    expect(onOpen).toBeGreaterThanOrEqual(1);

    // Positive control: the 4s poll really is running while open.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    const whilePolling = mockGetMemorySnapshot.mock.calls.length;
    expect(whilePolling).toBeGreaterThan(onOpen);

    await act(async () => {
      emitCached();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });

    // Caching is `removeChildView` + `setVisible(false)` — no interaction in
    // this document, so Radix never dismisses on its own and this poll would
    // otherwise outrun the badge poll in a view nobody can see.
    expect(mockGetMemorySnapshot.mock.calls.length).toBe(whilePolling);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips the popover poll while the window is hidden, and resumes after", async () => {
    await renderOpenBadge();
    const onOpen = mockGetMemorySnapshot.mock.calls.length;

    // Positive control: the 4s poll is running.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    const whileVisible = mockGetMemorySnapshot.mock.calls.length;
    expect(whileVisible).toBeGreaterThan(onOpen);

    documentHidden = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(mockGetMemorySnapshot.mock.calls.length).toBe(whileVisible);

    // Nothing was torn down, so it picks back up without a reopen.
    documentHidden = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(mockGetMemorySnapshot.mock.calls.length).toBeGreaterThan(whileVisible);
  });

  it("shows Unavailable instead of a fake zero when nothing was ever measured", async () => {
    mockGetMemorySnapshot.mockResolvedValue(
      makeMemorySnapshot({
        available: false,
        ageMs: null,
        sampledAt: 0,
        totalMemoryMb: 0,
        processCount: 0,
        terminalCount: 0,
      })
    );

    const container = await renderOpenBadge();

    const row = findMemoryRow(container, "Unavailable");
    expect(row?.children[0]?.textContent).toContain("Terminal programs");
    expect(container.textContent).toContain("Process table unavailable");
    expect(findMemoryRow(container, "0 MB")).toBeUndefined();
  });

  it("preserves the last good workload reading across an unavailable poll", async () => {
    const container = await renderOpenBadge();
    expect(container.textContent).toContain("900 MB");

    // The next popover poll finds the process table unreadable; the rollup
    // degrades to available:false with zeroed fresh values.
    mockGetMemorySnapshot.mockResolvedValue(
      makeMemorySnapshot({ available: false, totalMemoryMb: 0, processCount: 0 })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(container.textContent).toContain("900 MB");
    expect(container.textContent).toContain("showing last reading");
    expect(container.textContent).not.toContain("Unavailable —");
  });

  it("shows host-retained values on first open when the process table is already wedged", async () => {
    // The pty-host aggregates over its retained cache even when ps fails, so
    // the very first snapshot this renderer sees can be unavailable yet carry
    // real last-good numbers — they must render, flagged, not as Unavailable.
    mockGetMemorySnapshot.mockResolvedValue(
      makeMemorySnapshot({
        available: false,
        stale: false,
        ageMs: 10_000,
        sampledAt: Date.now() - 10_000,
        totalMemoryMb: 900,
      })
    );

    const container = await renderOpenBadge();

    expect(container.textContent).toContain("900 MB");
    expect(container.textContent).toContain("showing last reading");
    expect(container.textContent).not.toContain("Unavailable");
  });

  it("keeps the last good reading when the snapshot poll itself fails", async () => {
    const container = await renderOpenBadge();
    expect(container.textContent).toContain("900 MB");

    // The snapshot IPC rejects outright on the next poll; the stale-guarded
    // fallback must show the last good value with its note, not the previous
    // slice masquerading as a fresh measurement.
    mockGetMemorySnapshot.mockRejectedValue(new Error("ipc down"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(container.textContent).toContain("900 MB");
    expect(container.textContent).toContain("showing last reading");
  });

  it("flags a stale-but-available workload sample with its age", async () => {
    mockGetMemorySnapshot.mockResolvedValue(
      makeMemorySnapshot({ stale: true, ageMs: 45_000, sampledAt: Date.now() - 45_000 })
    );

    const container = await renderOpenBadge();

    expect(container.textContent).toContain("900 MB");
    expect(container.textContent).toContain("Last sampled 45s ago");
  });

  it("shows the memory summary when an unrelated diagnostics read fails", async () => {
    mockGetHeapStats.mockRejectedValue(new Error("heap read failed"));
    mockGetProcessMetrics.mockRejectedValue(new Error("process read failed"));

    const container = await renderOpenBadge();

    expect(findMemoryRow(container, "900 MB")).toBeDefined();
    expect(container.querySelector('[aria-label="Loading resource details"]')).toBeNull();
  });

  it("reports terminal memory as Unavailable when the snapshot fails from the start", async () => {
    mockGetMemorySnapshot.mockRejectedValue(new Error("snapshot ipc down"));

    const container = await renderOpenBadge();

    expect(findMemoryRow(container, "Unavailable")?.children[0]?.textContent).toBe(
      "Terminal programs"
    );
  });

  it("names the popover before its first read lands", async () => {
    mockGetProcessMetrics.mockReturnValue(new Promise(() => {}));
    mockGetHeapStats.mockReturnValue(new Promise(() => {}));
    mockGetDiagnosticsInfo.mockReturnValue(new Promise(() => {}));
    mockGetMemorySnapshot.mockReturnValue(new Promise(() => {}));

    const container = await renderOpenBadge();

    // The content takes focus on open and is labelled by this heading, so it
    // must exist while the skeleton is still showing.
    expect(container.querySelector('[aria-label="Loading resource details"]')).not.toBeNull();
    expect(container.querySelector("#resource-usage-title")?.textContent).toBe("Memory");
  });

  it("attributes terminal memory per project from the same snapshot as the total", async () => {
    mockGetAll.mockResolvedValue([
      makeProject({ id: "p1", name: "Light" }),
      makeProject({ id: "p2", name: "Heavy" }),
      makeProject({ id: "p3", name: "Dormant" }),
    ]);
    mockGetMemorySnapshot.mockResolvedValue(
      makeMemorySnapshot({
        byProject: [
          { projectId: null, terminalCount: 1, processCount: 1, memoryMb: 5_000, topProcesses: [] },
          { projectId: "p1", terminalCount: 1, processCount: 2, memoryMb: 200, topProcesses: [] },
          { projectId: "p2", terminalCount: 2, processCount: 4, memoryMb: 700, topProcesses: [] },
          { projectId: "p3", terminalCount: 0, processCount: 0, memoryMb: 0, topProcesses: [] },
        ],
      })
    );

    const container = await renderOpenBadge();
    const text = container.textContent ?? "";

    // Heaviest project first; the unattributed remainder last whatever its
    // size; a project with no terminals gets no row at all.
    expect(text.indexOf("Heavy")).toBeLessThan(text.indexOf("Light"));
    expect(text.indexOf("Light")).toBeLessThan(text.indexOf("Other terminals"));
    expect(text).not.toContain("Dormant");
    // Never the second read's path-bearing process names.
    expect(mockGetBulkStats).not.toHaveBeenCalled();
  });

  it("lists renderer terminal buffers per project view, cached and unanswered ones included", async () => {
    mockGetAll.mockResolvedValue([
      makeProject({ id: "p1", name: "Agents" }),
      makeProject({ id: "p2", name: "Backgrounded" }),
      makeProject({ id: "p3", name: "Silent" }),
    ]);
    const mb = 1024 * 1024;
    mockGetMemorySnapshot.mockResolvedValue({
      ...makeMemorySnapshot(),
      rendererTerminalBuffers: {
        complete: false,
        estimatedBytes: 30 * mb,
        views: [
          {
            webContentsId: 3,
            windowId: 1,
            projectId: "p3",
            state: "cached",
            status: "unavailable",
            sampledAt: null,
            ageMs: null,
            estimatedBytes: null,
            terminals: null,
          },
          {
            webContentsId: 2,
            windowId: 1,
            projectId: "p2",
            state: "cached",
            status: "last-known",
            sampledAt: Date.now() - 120_000,
            ageMs: 120_000,
            estimatedBytes: 5 * mb,
            terminals: [],
          },
          {
            webContentsId: 1,
            windowId: 1,
            projectId: "p1",
            state: "active",
            status: "fresh",
            sampledAt: Date.now(),
            ageMs: 0,
            estimatedBytes: 25 * mb,
            terminals: [],
          },
        ],
      },
    });

    const container = await renderOpenBadge();
    // Folded with the rest of the diagnostics until asked for.
    expect(
      container.ownerDocument.querySelector('[data-testid="terminal-buffer-breakdown"]')
    ).toBeNull();
    await openDiagnostics(container);
    const breakdown = container.ownerDocument.querySelector(
      '[data-testid="terminal-buffer-breakdown"]'
    );
    expect(breakdown).not.toBeNull();
    const text = breakdown?.textContent ?? "";

    // Partial coverage is named rather than passed off as the whole, with the
    // total on the heading's own line.
    expect(text.startsWith("Terminal buffers, est. (partial)~30 MB")).toBe(true);
    expect(text).toContain("Agents~25 MB");
    expect(text).toContain("Backgrounded~5 MB");
    expect(text).toContain("SilentUnavailable");
    // A cached view's age is in its row's hint, not its label.
    expect(await bufferRowHint(breakdown!, "Backgrounded")).toBe("Backgrounded · cached 2m ago");
    expect(await bufferRowHint(breakdown!, "Silent")).toBe("Silent · cached");
    expect(await bufferRowHint(breakdown!, "Agents")).toBeNull();
    // Heaviest first, the unanswered view last.
    expect(text.indexOf("Agents")).toBeLessThan(text.indexOf("Backgrounded"));
    expect(text.indexOf("Backgrounded")).toBeLessThan(text.indexOf("Silent"));
  });

  it("ages an active view's buffer reading once it stops answering, and names remote views by host", async () => {
    // A remote window lists its host's projects by bare id; views arrive host-scoped.
    Object.defineProperty(window, "__DAINTREE_HOST_ID__", {
      configurable: true,
      value: { id: "studio-01" },
    });
    try {
      mockGetAll.mockResolvedValue([makeProject({ id: "proj-a", name: "Remote repo" })]);
      const view = (webContentsId: number, projectId: string, ageMs: number) => ({
        webContentsId,
        windowId: webContentsId,
        projectId,
        state: "active" as const,
        status: "last-known" as const,
        sampledAt: Date.now() - ageMs,
        ageMs,
        estimatedBytes: 4 * 1024 * 1024,
        terminals: [],
      });
      mockGetMemorySnapshot.mockResolvedValue({
        ...makeMemorySnapshot(),
        rendererTerminalBuffers: {
          complete: true,
          estimatedBytes: 8 * 1024 * 1024,
          views: [view(1, "studio-01:proj-a", 90_000), view(2, "lab-02:proj-a", 0)],
        },
      });

      const container = await renderOpenBadge();
      await openDiagnostics(container);
      const breakdown = container.ownerDocument.querySelector(
        '[data-testid="terminal-buffer-breakdown"]'
      );
      expect(breakdown).not.toBeNull();
      const text = breakdown?.textContent ?? "";

      // Every view answered, so the heading claims the whole.
      expect(text.startsWith("Terminal buffers, est.~8 MB")).toBe(true);
      expect(text).toContain("Remote repo~4 MB");
      expect(await bufferRowHint(breakdown!, "Remote repo")).toBe("Remote repo · from 2m ago");
      // Same bare id on another host: not this host's project.
      expect(text).toContain("Project on lab-02");
    } finally {
      delete window.__DAINTREE_HOST_ID__;
    }
  });

  it("omits the buffer section when the snapshot didn't sample renderers", async () => {
    mockGetMemorySnapshot.mockResolvedValue(makeMemorySnapshot());

    const container = await renderOpenBadge();
    // The snapshot did land: Diagnostics no longer waits for it to mount.
    expect(findMemoryRow(container, "900 MB")).toBeDefined();
    await openDiagnostics(container);

    expect(container.querySelector("#resource-diagnostics")).not.toBeNull();
    expect(
      container.ownerDocument.querySelector('[data-testid="terminal-buffer-breakdown"]')
    ).toBeNull();
  });

  it("folds a long project list behind a disclosure whose label does not change", async () => {
    const projects = Array.from({ length: 8 }, (_, i) =>
      makeProject({ id: `p${i}`, name: `Project ${i}` })
    );
    mockGetAll.mockResolvedValue(projects);
    mockGetMemorySnapshot.mockResolvedValue(
      makeMemorySnapshot({
        byProject: projects.map((p, i) => ({
          projectId: p.id,
          terminalCount: 1,
          processCount: 1,
          memoryMb: 100 + i,
          topProcesses: [],
        })),
      })
    );

    const container = await renderOpenBadge();
    const countRows = () => projects.filter((p) => container.textContent?.includes(p.name)).length;
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-controls") === "resource-project-rows"
    )!;

    expect(countRows()).toBeLessThan(projects.length);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const closedLabel = toggle.textContent;

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(countRows()).toBe(projects.length);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe(closedLabel);
  });

  it("keeps process-level diagnostics folded until asked for", async () => {
    mockGetProcessMetrics.mockResolvedValue([
      { pid: 321, type: "GPU", name: "GPU", memoryMB: 90, cpuPercent: 0 },
    ]);

    const container = await renderOpenBadge();
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-controls") === "resource-diagnostics"
    )!;

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(await findProcessRowLabel(container, 321)).toBeNull();

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await findProcessRowLabel(container, 321)).not.toBeNull();
  });
});

describe("ProjectResourceBadge — popover poll ordering (#17574)", () => {
  beforeEach(setupDefaultMocks);

  afterEach(restoreTimersAndMocks);

  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
  } {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /** The freshness line beside the Memory heading, or null while it's silent. */
  function ageLabelOf(container: HTMLElement): string | null {
    const heading = container.querySelector("#resource-usage-title");
    expect(heading).not.toBeNull();
    return heading!.closest("div")?.nextElementSibling?.textContent ?? null;
  }

  /** The value of the label/value row named `label`, or undefined when it isn't shown. */
  function rowValue(container: HTMLElement, label: string): string | undefined {
    return (
      Array.from(container.querySelectorAll("div")).find(
        (el) => el.children.length === 2 && el.children[0]?.textContent === label
      )?.children[1]?.textContent ?? undefined
    );
  }

  const terminalProgramsValue = (container: HTMLElement) =>
    rowValue(container, "Terminal programs");
  const machineAvailableValue = (container: HTMLElement) =>
    rowValue(container, "Available on this machine");

  function info(systemAvailableMB: number) {
    return { uptimeSeconds: 60, eventLoopP99Ms: 10, systemAvailableMB };
  }

  it("keeps a slow collector to one read at a time while the others keep landing", async () => {
    const stalled = deferred<CompositeMemorySnapshot>();
    mockGetMemorySnapshot
      .mockResolvedValueOnce(makeMemorySnapshot())
      .mockReturnValueOnce(stalled.promise)
      .mockResolvedValue(makeMemorySnapshot({ totalMemoryMb: 1_500 }));
    mockGetDiagnosticsInfo
      .mockResolvedValueOnce(info(4096))
      .mockResolvedValueOnce(info(3072))
      .mockResolvedValue(info(2048));

    const container = await renderOpenBadge();
    expect(terminalProgramsValue(container)).toBe("900 MB");
    expect(machineAvailableValue(container)).toBe("4.0 GB");

    // The snapshot read started on the second tick never answers; the
    // diagnostics read beside it does, and must not wait on it.
    await advance(4_000);
    expect(machineAvailableValue(container)).toBe("3.0 GB");

    // Two more ticks: no second snapshot read stacks behind the stalled one,
    // while the healthy collector keeps its cadence.
    await advance(8_000);
    expect(mockGetMemorySnapshot).toHaveBeenCalledTimes(2);
    expect(mockGetDiagnosticsInfo).toHaveBeenCalledTimes(4);
    expect(machineAvailableValue(container)).toBe("2.0 GB");

    // Once the stalled read answers it lands alone: the machine figure read
    // beside it on that tick is long superseded and must not come back.
    await act(async () => {
      stalled.resolve(makeMemorySnapshot({ totalMemoryMb: 1_200 }));
    });
    expect(terminalProgramsValue(container)).toBe("1.2 GB");
    expect(machineAvailableValue(container)).toBe("2.0 GB");

    // And the next tick reads it again.
    await advance(4_000);
    expect(mockGetMemorySnapshot).toHaveBeenCalledTimes(3);
    expect(terminalProgramsValue(container)).toBe("1.5 GB");
  });

  it("never lets an older snapshot land over a newer one", async () => {
    const first = deferred<CompositeMemorySnapshot>();
    mockGetMemorySnapshot
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(makeMemorySnapshot({ totalMemoryMb: 1_200 }));

    const container = await renderOpenBadge();
    await advance(8_000);

    // Every value shown, in order: the first read lands while it is still the
    // newest, and the reading asked for after it replaces it, never the reverse.
    const shown: Array<string | undefined> = [terminalProgramsValue(container)];
    await act(async () => {
      first.resolve(makeMemorySnapshot({ totalMemoryMb: 600 }));
    });
    shown.push(terminalProgramsValue(container));
    await advance(4_000);
    shown.push(terminalProgramsValue(container));

    expect(shown).toEqual([undefined, "600 MB", "1.2 GB"]);
  });

  it("ages the Memory reading while its snapshot read is stalled, and dates it to its request", async () => {
    const stalled = deferred<CompositeMemorySnapshot>();
    mockGetMemorySnapshot
      .mockResolvedValueOnce(makeMemorySnapshot())
      .mockReturnValueOnce(stalled.promise)
      .mockResolvedValue(makeMemorySnapshot());

    const container = await renderOpenBadge();
    expect(ageLabelOf(container)).toBeNull();

    // The other three reads keep landing every 4s; none of them may refresh
    // the age of a Memory reading that is still the one from the first tick.
    await advance(14_000);
    expect(terminalProgramsValue(container)).toBe("900 MB");
    expect(ageLabelOf(container)).toBe("Updated 14s ago");

    // The stalled read answers at 14s, but it was asked for at 4s.
    await act(async () => {
      stalled.resolve(makeMemorySnapshot({ totalMemoryMb: 1_200 }));
    });
    expect(terminalProgramsValue(container)).toBe("1.2 GB");
    expect(ageLabelOf(container)).toBe("Updated 10s ago");

    // The next tick reads again, promptly, and the line falls silent.
    await advance(2_000);
    expect(ageLabelOf(container)).toBeNull();
  });

  it("ages the Memory reading while its snapshot read keeps failing", async () => {
    mockGetMemorySnapshot
      .mockResolvedValueOnce(makeMemorySnapshot())
      .mockRejectedValue(new Error("snapshot ipc down"));

    const container = await renderOpenBadge();
    expect(ageLabelOf(container)).toBeNull();

    // Three failed polls, each one beside three good reads and each one asked
    // again: the figure shown is still the first one, and the line says so.
    await advance(12_000);
    expect(mockGetMemorySnapshot).toHaveBeenCalledTimes(4);
    expect(terminalProgramsValue(container)).toBe("900 MB");
    expect(container.textContent).toContain("showing last reading");
    expect(ageLabelOf(container)).toBe("Updated 12s ago");
  });

  it("dates a retained workload figure by its own read while newer snapshots carry none", async () => {
    const later = makeMemorySnapshot({
      available: false,
      ageMs: null,
      sampledAt: 0,
      totalMemoryMb: 0,
      processCount: 0,
      terminalCount: 0,
    });
    later.electron.totalWorkingSetMb = 350;
    mockGetMemorySnapshot.mockResolvedValueOnce(makeMemorySnapshot()).mockResolvedValue(later);

    const container = await renderOpenBadge();
    expect(rowValue(container, "Daintree app")).toBe("300 MB");

    // Every later snapshot lands, its own app figure with it, but carries no
    // workload figure, so the first one's 900 MB stays on show with its date.
    await advance(12_000);
    expect(rowValue(container, "Daintree app")).toBe("350 MB");
    expect(terminalProgramsValue(container)).toBe("900 MB");
    expect(container.textContent).toContain("showing last reading");
    expect(ageLabelOf(container)).toBe("Updated 12s ago");
  });

  // One figure from the snapshot at a time, with no machine figure beside it,
  // so each of the heading's snapshot dates is the only one in play.
  it.each([
    {
      figure: "app",
      snapshot: () =>
        makeMemorySnapshot({
          available: false,
          ageMs: null,
          sampledAt: 0,
          totalMemoryMb: 0,
          processCount: 0,
          terminalCount: 0,
        }),
    },
    {
      figure: "workload",
      snapshot: () => {
        const snapshot = makeMemorySnapshot();
        snapshot.electron = { ...snapshot.electron, available: false, totalWorkingSetMb: 0 };
        return snapshot;
      },
    },
  ])(
    "ages the heading by the snapshot's $figure figure alone while that read stalls",
    async ({ snapshot }) => {
      mockGetDiagnosticsInfo.mockResolvedValue({ uptimeSeconds: 60, eventLoopP99Ms: 10 });
      mockGetMemorySnapshot
        .mockResolvedValueOnce(snapshot())
        .mockReturnValue(new Promise(() => {}));

      const container = await renderOpenBadge();
      expect(ageLabelOf(container)).toBeNull();

      await advance(12_000);
      expect(ageLabelOf(container)).toBe("Updated 12s ago");
    }
  );

  it("dates a late machine figure to its request while the snapshot keeps landing", async () => {
    const stalled = deferred<ReturnType<typeof info>>();
    let reading = 0;
    mockGetMemorySnapshot.mockImplementation(async () =>
      makeMemorySnapshot({ totalMemoryMb: 1_000 + 100 * reading++ })
    );
    mockGetDiagnosticsInfo
      .mockResolvedValueOnce(info(4096))
      .mockReturnValueOnce(stalled.promise)
      .mockResolvedValue(info(2048));

    const container = await renderOpenBadge();

    // The snapshot answers on every tick; the machine figure beside it is
    // still the first tick's, and the heading dates the oldest figure shown.
    await advance(12_000);
    expect(terminalProgramsValue(container)).toBe("1.3 GB");
    expect(machineAvailableValue(container)).toBe("4.0 GB");
    expect(ageLabelOf(container)).toBe("Updated 12s ago");

    // The stalled read answers at 15s, but it was asked for at 4s.
    await advance(3_000);
    await act(async () => {
      stalled.resolve(info(3072));
    });
    expect(machineAvailableValue(container)).toBe("3.0 GB");
    expect(ageLabelOf(container)).toBe("Updated 11s ago");
  });

  it("drops the machine figure's age along with its row when that read fails", async () => {
    const stalled = deferred<ReturnType<typeof info>>();
    mockGetDiagnosticsInfo
      .mockResolvedValueOnce(info(4096))
      .mockReturnValueOnce(stalled.promise)
      .mockResolvedValue(info(2048));

    const container = await renderOpenBadge();
    await advance(15_000);
    expect(ageLabelOf(container)).toBe("Updated 15s ago");

    // It fails at 15s, a read asked for at 4s: the row goes, and with it the
    // only old figure under the heading. The snapshot's is from 12s.
    await act(async () => {
      stalled.reject(new Error("diagnostics ipc down"));
    });
    expect(machineAvailableValue(container)).toBeUndefined();
    expect(ageLabelOf(container)).toBeNull();

    // The next tick asks again, and the row comes back.
    await advance(1_000);
    expect(machineAvailableValue(container)).toBe("2.0 GB");
  });

  it("keeps the heading silent over the skeleton while only the other reads have landed", async () => {
    mockGetMemorySnapshot.mockReturnValue(new Promise(() => {}));
    mockGetDiagnosticsInfo.mockResolvedValueOnce(info(4096)).mockReturnValue(new Promise(() => {}));

    const container = await renderOpenBadge();
    await advance(12_000);

    // No Memory figure is on show, so nothing under the heading has an age;
    // the diagnostics that did answer are there to read.
    expect(container.querySelector('[aria-label="Loading resource details"]')).not.toBeNull();
    expect(ageLabelOf(container)).toBeNull();
    await openDiagnostics(container);
    expect(rowValue(container, "Main process JS heap")).toBe("100 MB of 200 MB");
    expect(rowValue(container, "Uptime")).toBe("1m");
    expect(container.querySelector('[aria-label="Loading resource details"]')).not.toBeNull();
  });

  it("leaves a diagnostics row off while its first read is out, rather than calling it Unavailable", async () => {
    const heap = deferred<{
      usedMB: number;
      limitMB: number;
      percent: number;
      externalMB: number;
    }>();
    const processes = deferred<ProcessMetricEntry[]>();
    mockGetHeapStats.mockReturnValueOnce(heap.promise);
    mockGetProcessMetrics.mockReturnValueOnce(processes.promise);

    const container = await renderOpenBadge();
    await openDiagnostics(container);

    expect(rowValue(container, "Uptime")).toBe("1m");
    expect(rowValue(container, "Main process JS heap")).toBeUndefined();
    expect(container.textContent).not.toContain("Process list unavailable");
    expect(container.textContent).not.toContain("Daintree processes");

    // Neither is asked again while it is out.
    await advance(8_000);
    expect(mockGetHeapStats).toHaveBeenCalledTimes(1);
    expect(mockGetProcessMetrics).toHaveBeenCalledTimes(1);

    await act(async () => {
      heap.resolve({ usedMB: 150, limitMB: 300, percent: 50, externalMB: 10 });
      processes.reject(new Error("process read failed"));
    });
    expect(rowValue(container, "Main process JS heap")).toBe("150 MB of 300 MB");
    expect(container.textContent).toContain("Process list unavailable");
  });

  it("keeps a read still out across a close and reopen to its one call, and lands it", async () => {
    const stalled = deferred<CompositeMemorySnapshot>();
    mockGetMemorySnapshot
      .mockResolvedValueOnce(makeMemorySnapshot())
      .mockReturnValueOnce(stalled.promise)
      .mockResolvedValue(makeMemorySnapshot({ totalMemoryMb: 1_500 }));

    const container = await renderOpenBadge();
    await advance(4_000);
    expect(mockGetMemorySnapshot).toHaveBeenCalledTimes(2);

    // Caching the view closes the popover; revealing it and clicking the
    // readout opens it again with the snapshot read still out.
    await act(async () => {
      emitCached();
    });
    await act(async () => {
      emitRevealed();
    });
    const infoCallsBeforeReopen = mockGetDiagnosticsInfo.mock.calls.length;
    await act(async () => {
      fireEvent.click(container.querySelector("button")!);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The free collectors read straight away; the stalled one is not asked twice.
    expect(mockGetDiagnosticsInfo.mock.calls.length).toBe(infoCallsBeforeReopen + 1);
    expect(mockGetMemorySnapshot).toHaveBeenCalledTimes(2);

    // Its answer is still the newest of its kind, so it shows.
    await act(async () => {
      stalled.resolve(makeMemorySnapshot({ totalMemoryMb: 1_200 }));
    });
    expect(terminalProgramsValue(container)).toBe("1.2 GB");
  });

  it("keeps a reading that answered while the popover was closed", async () => {
    const stalled = deferred<CompositeMemorySnapshot>();
    mockGetMemorySnapshot
      .mockResolvedValueOnce(makeMemorySnapshot())
      .mockReturnValueOnce(stalled.promise)
      .mockReturnValue(new Promise(() => {}));

    const container = await renderOpenBadge();
    await advance(4_000);

    await act(async () => {
      emitCached();
    });
    await act(async () => {
      stalled.resolve(makeMemorySnapshot({ totalMemoryMb: 1_200 }));
    });
    await act(async () => {
      emitRevealed();
    });
    await act(async () => {
      fireEvent.click(container.querySelector("button")!);
    });

    // The reopen's own snapshot read hasn't answered; what shows is the one
    // that landed while closed, not the reading from before it.
    expect(mockGetMemorySnapshot).toHaveBeenCalledTimes(3);
    expect(terminalProgramsValue(container)).toBe("1.2 GB");
  });
});

describe("ProjectResourceBadge — process ownership", () => {
  beforeEach(setupDefaultMocks);

  afterEach(restoreTimersAndMocks);

  function makeProcess(overrides: Partial<ProcessMetricEntry> = {}): ProcessMetricEntry {
    return { pid: 400, type: "Tab", name: "Tab", memoryMB: 100, cpuPercent: 1, ...overrides };
  }

  async function renderWithDiagnostics(): Promise<HTMLElement> {
    const container = await renderOpenBadge();
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-controls") === "resource-diagnostics"
    )!;
    await act(async () => {
      fireEvent.click(toggle);
    });
    return container;
  }

  /** The process row's label text, located by the pid its tooltip carries. */
  async function processRowLabel(container: HTMLElement, pid: number): Promise<string> {
    const found = await findProcessRowLabel(container, pid);
    if (!found) throw new Error(`No process row for pid ${pid}`);
    return found.label.textContent ?? "";
  }

  it("names the owning project instead of the generic renderer label", async () => {
    mockGetProcessMetrics.mockResolvedValue([makeProcess({ projectNames: ["RuinWeave"] })]);

    const container = await renderWithDiagnostics();

    expect(await processRowLabel(container, 400)).toBe("RuinWeave view");
  });

  it("surfaces the full label on hover when the row truncates", async () => {
    mockGetProcessMetrics.mockResolvedValue([
      makeProcess({ projectNames: ["Cedar Forge", "RuinWeave"] }),
    ]);

    const container = await renderWithDiagnostics();

    // Through the app's tooltip, never a native title.
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
    const found = await findProcessRowLabel(container, 400);
    expect(found?.tooltip).toBe("2 views · Cedar Forge, RuinWeave (400)");
  });
});

describe("ProjectResourceBadge — plugin tasks (#13819)", () => {
  beforeEach(setupDefaultMocks);

  afterEach(() => {
    _resetPluginTaskStoreForTest();
    restoreTimersAndMocks();
  });

  it("lists running plugin tasks under their own heading, before memory", async () => {
    const task = {
      id: "t-1",
      pluginId: "acme",
      pluginName: "Acme",
      title: "Importing records",
      fraction: 0.5,
      cancellable: true,
      state: "working" as const,
      startedAt: 1,
    };
    usePluginTaskStore.setState({ tasks: [task], tasksByPluginId: { acme: [task] } });
    const container = await renderOpenBadge();

    // The popover is named by both headings (aria-labelledby on the real
    // content, which this suite stubs), so both must exist.
    const heading = container.querySelector("#plugin-tasks-title");
    const memory = container.querySelector("#resource-usage-title");
    expect(heading?.textContent).toBe("Plugin tasks");
    expect(memory?.textContent).toBe("Memory");
    expect(
      heading!.compareDocumentPosition(memory!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    const list = screen.getByRole("list", { name: "Plugin tasks" });
    expect(list.textContent).toContain("Importing records");
    expect(list.textContent).toContain("Acme");
    expect(screen.getByRole("button", { name: "Cancel Importing records" })).toBeTruthy();
  });

  it("leaves the section out entirely while no plugin has a task", async () => {
    const container = await renderOpenBadge();

    expect(container.querySelector("#plugin-tasks-title")).toBeNull();
    expect(screen.queryByRole("list", { name: "Plugin tasks" })).toBeNull();
  });
});
