// @vitest-environment jsdom
/**
 * ProjectResourceBadge — popover memory honesty.
 *
 * The popover must label measured vs estimated memory truthfully: measured
 * workload totals come from the composite memory snapshot, unavailable reads
 * preserve the last good value with an explicit note (never a fake 0), and
 * per-project estimates carry the `~` legend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render } from "@testing-library/react";
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
vi.mock("@/store/projectStatsStore", () => ({
  useProjectStatsStore: {
    getState: () => statsStoreState,
  },
}));

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
import type { BulkProjectStatsEntry } from "@shared/types/ipc/project";
import type {
  CompositeMemorySnapshot,
  TerminalWorkloadSlice,
} from "@shared/types/memoryAccounting";
import type { ProcessMetricEntry } from "@shared/types/ipc/system";
import { ProjectResourceBadge } from "../ProjectResourceBadge";

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
      processCount: 4,
      sampledAt: Date.now(),
    },
    terminalWorkloads: makeWorkloads(workloadOverrides),
  };
}

function makeBulkStatsEntry(overrides: Partial<BulkProjectStatsEntry> = {}): BulkProjectStatsEntry {
  return {
    processCount: 2,
    terminalCount: 2,
    estimatedMemoryMB: 100,
    terminalTypes: {},
    processIds: [],
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    ...overrides,
  };
}

async function renderOpenBadge(): Promise<HTMLElement> {
  const { container } = render(<ProjectResourceBadge />);
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
let documentHidden = false;
let originalHidden: boolean;

function emitCached(): void {
  Array.from(cachedHandlers).forEach((h) => h());
}

function findMemoryRow(container: HTMLElement, value: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll("div")).find(
    (el) => el.children.length === 2 && el.children[1].textContent === value
  );
}

function setupDefaultMocks(): void {
  vi.useFakeTimers();
  cachedHandlers = new Set();
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
      onViewRevealed: () => () => {},
      isViewCached: () => false,
    },
  });
  __resetProjectViewCacheStateForTests();
  mockGetAll.mockReset().mockResolvedValue([makeProject()]);
  mockGetBulkStats.mockReset().mockResolvedValue({
    p1: makeBulkStatsEntry({
      terminalMemoryMB: 750,
      topProcess: { name: "node", memoryMB: 400 },
    }),
  });
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

    // Scoped to the row carrying the measured figure, and asserted on meaning
    // rather than the exact sentence: the row must name what it measures and
    // disclose the double-count instead of claiming a footprint it isn't.
    const workingSetRow = findMemoryRow(container, "300MB");
    expect(workingSetRow).toBeDefined();
    const workingSetLabel = workingSetRow?.children[0].textContent?.toLowerCase() ?? "";
    expect(workingSetLabel).toContain("working set");
    expect(workingSetLabel).toContain("shared pages");
    expect(workingSetLabel).not.toContain("app memory");
    expect(container.textContent).toContain("Terminal workloads");
    expect(container.textContent).toContain("900MB");
    // Measured per-project value renders without the estimate marker or legend.
    expect(container.textContent).toContain("750MB");
    expect(container.textContent).not.toContain("~");
    expect(container.textContent).not.toContain("estimated from terminal count");
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

    expect(container.textContent).toContain("Terminal workloads");
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Process table unavailable");
    expect(container.textContent).not.toContain("Terminal workloads0MB");
  });

  it("preserves the last good workload reading across an unavailable poll", async () => {
    const container = await renderOpenBadge();
    expect(container.textContent).toContain("900MB");

    // The next popover poll finds the process table unreadable; the rollup
    // degrades to available:false with zeroed fresh values.
    mockGetMemorySnapshot.mockResolvedValue(
      makeMemorySnapshot({ available: false, totalMemoryMb: 0, processCount: 0 })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(container.textContent).toContain("900MB");
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

    expect(container.textContent).toContain("900MB");
    expect(container.textContent).toContain("showing last reading");
    expect(container.textContent).not.toContain("Unavailable");
  });

  it("keeps the last good reading when the snapshot poll itself fails", async () => {
    const container = await renderOpenBadge();
    expect(container.textContent).toContain("900MB");

    // The snapshot IPC rejects outright on the next poll; the stale-guarded
    // fallback must show the last good value with its note, not the previous
    // slice masquerading as a fresh measurement.
    mockGetMemorySnapshot.mockRejectedValue(new Error("ipc down"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(container.textContent).toContain("900MB");
    expect(container.textContent).toContain("showing last reading");
  });

  it("flags a stale-but-available workload sample with its age", async () => {
    mockGetMemorySnapshot.mockResolvedValue(
      makeMemorySnapshot({ stale: true, ageMs: 45_000, sampledAt: Date.now() - 45_000 })
    );

    const container = await renderOpenBadge();

    expect(container.textContent).toContain("900MB");
    expect(container.textContent).toContain("Last sampled 45s ago");
  });

  it("marks per-project estimates with the ~ legend when unmeasured", async () => {
    mockGetBulkStats.mockResolvedValue({
      p1: makeBulkStatsEntry({ terminalCount: 3, estimatedMemoryMB: 150 }),
    });

    const container = await renderOpenBadge();

    expect(container.textContent).toContain("~150MB");
    expect(container.textContent).toContain("estimated from terminal count, not measured");
  });
});

describe("ProjectResourceBadge — process ownership", () => {
  beforeEach(setupDefaultMocks);

  afterEach(restoreTimersAndMocks);

  function makeProcess(overrides: Partial<ProcessMetricEntry> = {}): ProcessMetricEntry {
    return { pid: 400, type: "Tab", name: "Tab", memoryMB: 100, cpuPercent: 1, ...overrides };
  }

  /** The process row's label cell, located by the pid it renders. */
  function processRowLabel(container: HTMLElement, pid: number): string {
    const row = container.querySelector(`[title$="(${pid})"]`);
    if (!row) throw new Error(`No process row for pid ${pid}`);
    return row.textContent ?? "";
  }

  it("names the owning project instead of the generic renderer label", async () => {
    mockGetProcessMetrics.mockResolvedValue([makeProcess({ projectNames: ["RuinWeave"] })]);

    const container = await renderOpenBadge();

    expect(processRowLabel(container, 400)).toBe("RuinWeave view (400)");
  });

  it("leaves an unowned process on its generic label", async () => {
    mockGetProcessMetrics.mockResolvedValue([
      makeProcess({ pid: 200, type: "GPU", name: "GPU Process" }),
    ]);

    const container = await renderOpenBadge();

    // Scoped to the row: unrelated popover copy may legitimately say "view".
    expect(processRowLabel(container, 200)).toBe("GPU Process (200)");
  });

  it("surfaces the full label on hover when the row truncates", async () => {
    mockGetProcessMetrics.mockResolvedValue([
      makeProcess({ projectNames: ["Cedar Forge", "RuinWeave"] }),
    ]);

    const container = await renderOpenBadge();

    const row = container.querySelector('[title*="RuinWeave"]');
    expect(row?.getAttribute("title")).toBe("2 views · Cedar Forge, RuinWeave (400)");
  });
});
