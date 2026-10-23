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
let documentHidden = false;
let originalHidden: boolean;

function emitCached(): void {
  Array.from(cachedHandlers).forEach((h) => h());
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

function findMemoryRow(container: HTMLElement, value: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll("div")).find(
    (el) => el.children.length === 2 && el.children[1]?.textContent === value
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
    expect(container.textContent?.toLowerCase()).toContain("counted twice");
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
    const breakdown = container.ownerDocument.querySelector(
      '[data-testid="terminal-buffer-breakdown"]'
    );
    const text = breakdown?.textContent ?? "";

    expect(text).toContain("estimate");
    // Partial coverage is named rather than passed off as the whole.
    expect(text).toContain("Projects that reported~30 MB");
    expect(text).toContain("Agents~25 MB");
    expect(text).toContain("Backgrounded · cached 2m ago~5 MB");
    expect(text).toContain("Silent · cachedUnavailable");
    // Heaviest first, the unanswered view last.
    expect(text.indexOf("Agents")).toBeLessThan(text.indexOf("Backgrounded"));
    expect(text.indexOf("Backgrounded")).toBeLessThan(text.indexOf("Silent"));
  });

  it("ages an active view's buffer reading once it stops answering, and names remote views", async () => {
    mockGetAll.mockResolvedValue([makeProject({ id: "proj-a", name: "Remote repo" })]);
    mockGetMemorySnapshot.mockResolvedValue({
      ...makeMemorySnapshot(),
      rendererTerminalBuffers: {
        complete: true,
        estimatedBytes: 4 * 1024 * 1024,
        views: [
          {
            webContentsId: 1,
            windowId: 1,
            projectId: "studio-01:proj-a",
            state: "active",
            status: "last-known",
            sampledAt: Date.now() - 90_000,
            ageMs: 90_000,
            estimatedBytes: 4 * 1024 * 1024,
            terminals: [],
          },
        ],
      },
    });

    const container = await renderOpenBadge();
    const text =
      container.ownerDocument.querySelector('[data-testid="terminal-buffer-breakdown"]')
        ?.textContent ?? "";

    expect(text).toContain("Remote repo · from 2m ago~4 MB");
  });

  it("omits the buffer section when the snapshot didn't sample renderers", async () => {
    mockGetMemorySnapshot.mockResolvedValue(makeMemorySnapshot());

    const container = await renderOpenBadge();

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
