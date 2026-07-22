import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const dialogMock = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
}));

const createWriteStreamMock = vi.hoisted(() =>
  vi.fn(() => {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const stream = {
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        listeners[event] ??= [];
        listeners[event].push(fn);
        return stream;
      }),
      emit: (event: string, ...args: unknown[]) => {
        listeners[event]?.forEach((fn) => {
          fn(...args);
        });
      },
      end: vi.fn(),
    };
    return stream;
  })
);

const archiverMock = vi.hoisted(() => {
  const archiveListeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const archive = {
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      archiveListeners[event] ??= [];
      archiveListeners[event].push(fn);
      return archive;
    }),
    pipe: vi.fn((output: { emit: (event: string, ...args: unknown[]) => void }) => {
      // Mirror archiver's behavior of closing the output stream after finalize.
      queueMicrotask(() => {
        output.emit("close");
      });
    }),
    append: vi.fn(),
    finalize: vi.fn(() => Promise.resolve()),
  };
  return vi.fn(function () {
    return archive;
  });
});

const resilientAtomicWriteFileMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

const collectDiagnosticsWithKeysMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ payload: { metadata: {} }, sectionKeys: ["metadata"] }))
);

// privateBytes is 0 here to mirror the real macOS/Linux shape: privateBytes is
// a Windows-only field that reports 0 elsewhere (lesson #8646). Reading it would
// sum to zero on 2 of 3 platforms, so the handlers must use workingSetSize. A
// fixture with populated privateBytes would pass even if that bug regressed.
const appMock = vi.hoisted(() => ({
  getAppMetrics: vi.fn(() => [
    {
      pid: 100,
      type: "Browser",
      name: "Browser",
      memory: { privateBytes: 0, workingSetSize: 204800 },
      cpu: { percentCPUUsage: 5.5 },
    },
    {
      pid: 200,
      type: "GPU",
      name: "GPU Process",
      memory: { privateBytes: 0, workingSetSize: 51200 },
      cpu: { percentCPUUsage: 2.3 },
    },
    {
      pid: 300,
      type: "Utility",
      name: "Network Service",
      memory: { privateBytes: 0, workingSetSize: 40960 },
      cpu: undefined,
    },
  ]),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  app: appMock,
  dialog: dialogMock,
  shell: shellMock,
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
  },
  // The real webContentsRegistry loads through importOriginal below, so the
  // electron surface it imports at module scope has to exist here.
  WebContentsView: vi.fn(),
  webContents: { fromId: vi.fn(() => null) },
}));

const chmodMock = vi.hoisted(() =>
  vi.fn<(path: string, mode: number) => Promise<void>>(() => Promise.resolve())
);
const readFileMock = vi.hoisted(() =>
  vi.fn<(path: string) => Promise<string>>(() => Promise.resolve("log line"))
);
const statMock = vi.hoisted(() =>
  vi.fn<(path: string) => Promise<{ mtimeMs: number }>>(() =>
    Promise.resolve({ mtimeMs: Date.now() })
  )
);
const existsSyncMock = vi.hoisted(() => vi.fn<(path: string) => boolean>(() => false));

vi.mock("node:fs", () => ({
  promises: {
    readFile: readFileMock,
    chmod: chmodMock,
    stat: statMock,
  },
  createWriteStream: createWriteStreamMock,
  existsSync: existsSyncMock,
}));

vi.mock("../../../utils/logger.js", () => ({
  getLogFilePath: () => "/logs/daintree.log",
  getLogDirectory: () => "/logs",
}));

vi.mock("archiver", () => ({
  ZipArchive: archiverMock,
}));

vi.mock("../../../utils/fs.js", () => ({
  resilientAtomicWriteFile: resilientAtomicWriteFileMock,
}));

vi.mock("node:v8", () => ({
  default: {
    getHeapStatistics: () => ({
      heap_size_limit: 4294967296,
      total_heap_size: 100000000,
      used_heap_size: 50000000,
    }),
  },
}));

vi.mock("node:perf_hooks", () => ({
  performance: {
    now: () => Date.now(),
    timeOrigin: Date.now(),
  },
  monitorEventLoopDelay: () => ({
    enable: vi.fn(),
    disable: vi.fn(),
    percentile: () => 12_000_000,
    reset: vi.fn(),
  }),
}));

vi.mock("../../../services/DiagnosticsCollector.js", () => ({
  collectDiagnostics: vi.fn(() => Promise.resolve({})),
  collectDiagnosticsWithKeys: collectDiagnosticsWithKeysMock,
}));

const recordBlinkSampleMock = vi.hoisted(() => vi.fn());
const recordEluSampleMock = vi.hoisted(() => vi.fn());

vi.mock("../../../services/ProcessMemoryMonitor.js", () => ({
  recordBlinkSample: recordBlinkSampleMock,
  recordEluSample: recordEluSampleMock,
}));

const getRegisteredProjectViewsMock = vi.hoisted(() =>
  vi.fn<() => Array<{ webContents: unknown; projectId: string }>>(() => [])
);

// Spread the real module: buildIpcContext imports seven other members from it,
// and a bare factory would shadow them all away.
vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../window/webContentsRegistry.js")>()),
  getRegisteredProjectViews: getRegisteredProjectViewsMock,
}));

const getProjectByIdMock = vi.hoisted(() =>
  vi.fn<(projectId: string) => { name: string } | null>(() => null)
);

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: getProjectByIdMock },
}));

import { registerDiagnosticsHandlers } from "../diagnostics.js";
import { resetAppMetricsSnapshotForTesting } from "../../../utils/appMetricsSnapshot.js";

function getHandlerFn(channelName: string): (...args: unknown[]) => unknown {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channelName);
  if (!call) throw new Error(`No handler registered for ${channelName}`);
  return call[1] as (...args: unknown[]) => unknown;
}

describe("registerDiagnosticsHandlers", () => {
  const deps = { mainWindow: {} } as Parameters<typeof registerDiagnosticsHandlers>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call data but not implementations, so restore the
    // defaults each test to keep the rotated-log tests isolated.
    existsSyncMock.mockReturnValue(false);
    statMock.mockResolvedValue({ mtimeMs: Date.now() });
    readFileMock.mockResolvedValue("log line");
    // The metrics handlers read through a 5s shared cache; clear it so each
    // test's mocked getAppMetrics (incl. per-test throw overrides) actually runs.
    resetAppMetricsSnapshotForTesting();
    getRegisteredProjectViewsMock.mockReturnValue([]);
    getProjectByIdMock.mockReturnValue(null);
  });

  it("registers all expected IPC handlers", () => {
    const cleanup = registerDiagnosticsHandlers(deps);
    const channels = ipcMainMock.handle.mock.calls.map((c: unknown[]) => c[0]);
    expect(channels).toContain("system:get-app-metrics");
    expect(channels).toContain("system:get-hardware-info");
    expect(channels).toContain("diagnostics:get-process-metrics");
    expect(channels).toContain("diagnostics:get-heap-stats");
    expect(channels).toContain("diagnostics:get-info");
    expect(channels).toContain("system:download-diagnostics");
    expect(channels).toContain("system:report-blink-memory");
    expect(channels).toContain("system:report-renderer-elu");
    expect(channels).toContain("system:get-report-enrichment");
    expect(channels).toContain("system:renderer-cpu-profile-start");
    expect(channels).toContain("system:renderer-cpu-profile-stop");
    cleanup();
  });

  it("cleanup removes all handlers", () => {
    const cleanup = registerDiagnosticsHandlers(deps);
    const handlerCount = ipcMainMock.handle.mock.calls.length;
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledTimes(handlerCount);
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("diagnostics:get-process-metrics");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("diagnostics:get-heap-stats");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("diagnostics:get-info");
  });

  describe("handleGetProcessMetrics", () => {
    it("returns per-process metrics sorted by memory descending", () => {
      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("diagnostics:get-process-metrics");
      const result = handler() as Array<{
        pid: number;
        type: string;
        name: string;
        memoryMB: number;
        cpuPercent: number;
      }>;

      expect(result).toHaveLength(3);
      // workingSetSize 204800 KB / 1024 = 200 MB (NOT privateBytes, which is 0).
      expect(result[0].pid).toBe(100);
      expect(result[0].memoryMB).toBe(200);
      expect(result[0].cpuPercent).toBe(5.5);
      expect(result[0].name).toBe("Browser");

      // workingSetSize 51200 KB / 1024 = 50 MB
      expect(result[1].pid).toBe(200);
      expect(result[1].memoryMB).toBe(50);

      // CPU defaults to 0 when cpu is undefined; workingSetSize 40960 / 1024 = 40 MB
      expect(result[2].pid).toBe(300);
      expect(result[2].memoryMB).toBe(40);
      expect(result[2].cpuPercent).toBe(0);

      // Sorted by memoryMB descending
      expect(result[0].memoryMB).toBeGreaterThanOrEqual(result[1].memoryMB);
      expect(result[1].memoryMB).toBeGreaterThanOrEqual(result[2].memoryMB);
    });

    it("returns empty array on error", () => {
      appMock.getAppMetrics.mockImplementationOnce(() => {
        throw new Error("fail");
      });
      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("diagnostics:get-process-metrics");
      expect(handler()).toEqual([]);
    });

    type ProcessRow = { pid: number; type: string; name: string; projectNames?: string[] };

    function createProjectView(projectId: string, osProcessId: number | (() => number)) {
      return {
        projectId,
        webContents: {
          isDestroyed: vi.fn(() => false),
          getOSProcessId: vi.fn(
            typeof osProcessId === "function" ? osProcessId : () => osProcessId
          ),
        },
      };
    }

    /** Adds Tab processes to the fixture without disturbing the shared non-Tab rows. */
    function withTabPids(...pids: number[]): void {
      const base = appMock.getAppMetrics();
      appMock.getAppMetrics.mockReturnValueOnce([
        ...base,
        ...pids.map((pid) => ({
          pid,
          type: "Tab",
          name: "Tab",
          memory: { privateBytes: 0, workingSetSize: 102400 },
          // Deliberately not a round number, so the row exercises the handler's
          // rounding rather than passing a value straight through.
          cpu: { percentCPUUsage: 1.26 },
        })),
      ]);
      resetAppMetricsSnapshotForTesting();
    }

    function getProcessRows(): ProcessRow[] {
      registerDiagnosticsHandlers(deps);
      return getHandlerFn("diagnostics:get-process-metrics")() as ProcessRow[];
    }

    function rowForPid(rows: ProcessRow[], pid: number): ProcessRow {
      const row = rows.find((r) => r.pid === pid);
      if (!row) throw new Error(`No process row for pid ${pid}`);
      return row;
    }

    it("labels a Tab process with the project rendering in it", () => {
      withTabPids(400);
      getRegisteredProjectViewsMock.mockReturnValue([createProjectView("project-a", 400)]);
      getProjectByIdMock.mockImplementation((id) =>
        id === "project-a" ? { name: "RuinWeave" } : null
      );

      expect(rowForPid(getProcessRows(), 400).projectNames).toEqual(["RuinWeave"]);
    });

    it("reports every project when Chromium consolidates views into one renderer", () => {
      withTabPids(400);
      getRegisteredProjectViewsMock.mockReturnValue([
        createProjectView("project-a", 400),
        createProjectView("project-b", 400),
      ]);
      getProjectByIdMock.mockImplementation(
        (id) =>
          ({ "project-a": { name: "RuinWeave" }, "project-b": { name: "Cedar Forge" } })[id] ?? null
      );

      // Sorted, so the label stays stable across polls regardless of view order.
      expect(rowForPid(getProcessRows(), 400).projectNames).toEqual(["Cedar Forge", "RuinWeave"]);
    });

    it("dedupes a project whose views share one renderer", () => {
      withTabPids(400);
      getRegisteredProjectViewsMock.mockReturnValue([
        createProjectView("project-a", 400),
        createProjectView("project-a", 400),
      ]);
      getProjectByIdMock.mockReturnValue({ name: "RuinWeave" });

      expect(rowForPid(getProcessRows(), 400).projectNames).toEqual(["RuinWeave"]);
    });

    it("counts same-named projects separately, since names are not unique", () => {
      withTabPids(400);
      getRegisteredProjectViewsMock.mockReturnValue([
        createProjectView("project-a", 400),
        createProjectView("project-b", 400),
      ]);
      // Two distinct repos can carry the same name; they are still two owners.
      getProjectByIdMock.mockReturnValue({ name: "api" });

      expect(rowForPid(getProcessRows(), 400).projectNames).toEqual(["api", "api"]);
    });

    it("keeps each renderer's label to the projects actually running in it", () => {
      withTabPids(400, 401);
      getRegisteredProjectViewsMock.mockReturnValue([
        createProjectView("project-a", 400),
        createProjectView("project-b", 401),
      ]);
      getProjectByIdMock.mockImplementation(
        (id) =>
          ({ "project-a": { name: "RuinWeave" }, "project-b": { name: "Cedar Forge" } })[id] ?? null
      );

      const rows = getProcessRows();
      expect(rowForPid(rows, 400).projectNames).toEqual(["RuinWeave"]);
      expect(rowForPid(rows, 401).projectNames).toEqual(["Cedar Forge"]);
    });

    it("leaves non-Tab processes generic even when a project view reports their pid", () => {
      // pid 200 is the GPU process in the shared fixture.
      getRegisteredProjectViewsMock.mockReturnValue([createProjectView("project-a", 200)]);
      getProjectByIdMock.mockReturnValue({ name: "RuinWeave" });

      const gpu = rowForPid(getProcessRows(), 200);
      expect(gpu.projectNames).toBeUndefined();
      expect(gpu.name).toBe("GPU Process");
    });

    it("never reads the pid of a destroyed view", () => {
      withTabPids(400);
      const view = createProjectView("project-a", 400);
      view.webContents.isDestroyed.mockReturnValue(true);
      getRegisteredProjectViewsMock.mockReturnValue([view]);
      getProjectByIdMock.mockReturnValue({ name: "RuinWeave" });

      // getOSProcessId() throws on a destroyed webContents, so it must not be called.
      expect(rowForPid(getProcessRows(), 400).projectNames).toBeUndefined();
      expect(view.webContents.getOSProcessId).not.toHaveBeenCalled();
    });

    it("ignores pid 0, which means the renderer has not spawned or has crashed", () => {
      withTabPids(0);
      getRegisteredProjectViewsMock.mockReturnValue([createProjectView("project-a", 0)]);
      getProjectByIdMock.mockReturnValue({ name: "RuinWeave" });

      expect(rowForPid(getProcessRows(), 0).projectNames).toBeUndefined();
    });

    it("skips views whose project record is gone", () => {
      withTabPids(400);
      getRegisteredProjectViewsMock.mockReturnValue([createProjectView("project-a", 400)]);
      getProjectByIdMock.mockReturnValue(null);

      expect(rowForPid(getProcessRows(), 400).projectNames).toBeUndefined();
    });

    it("keeps labelling the other projects when one view is torn down mid-read", () => {
      withTabPids(400, 401);
      getRegisteredProjectViewsMock.mockReturnValue([
        createProjectView("project-a", () => {
          throw new Error("Object has been destroyed");
        }),
        createProjectView("project-b", 401),
      ]);
      getProjectByIdMock.mockImplementation(
        (id) =>
          ({ "project-a": { name: "RuinWeave" }, "project-b": { name: "Cedar Forge" } })[id] ?? null
      );

      const rows = getProcessRows();
      // The throwing view neither blanks the table nor suppresses its siblings.
      expect(rowForPid(rows, 400).projectNames).toBeUndefined();
      expect(rowForPid(rows, 401).projectNames).toEqual(["Cedar Forge"]);
    });

    it("preserves memory, cpu and sort order while labelling", () => {
      withTabPids(400);
      getRegisteredProjectViewsMock.mockReturnValue([createProjectView("project-a", 400)]);
      getProjectByIdMock.mockReturnValue({ name: "RuinWeave" });

      const rows = getProcessRows() as Array<ProcessRow & { memoryMB: number; cpuPercent: number }>;
      const tab = rowForPid(rows, 400) as ProcessRow & { memoryMB: number; cpuPercent: number };
      // workingSetSize 102400 KB / 1024 = 100 MB, from workingSetSize not privateBytes.
      expect(tab.memoryMB).toBe(100);
      // 1.26 rounded to one decimal.
      expect(tab.cpuPercent).toBe(1.3);
      const memory = rows.map((r) => r.memoryMB);
      expect(memory).toEqual([...memory].sort((a, b) => b - a));
    });
  });

  describe("handleGetAppMetrics", () => {
    it("sums workingSetSize across processes (not the macOS/Linux-zero privateBytes)", () => {
      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("system:get-app-metrics");
      const result = handler() as { totalMemoryMB: number; unavailable?: true };

      // (204800 + 51200 + 40960) KB / 1024 = 290 MB. Reading privateBytes would
      // sum to 0 here — that's the regression this guards.
      expect(result.totalMemoryMB).toBe(290);
      expect(result.unavailable).toBeUndefined();
    });

    it("flags unavailable instead of returning a misleading 0 on error", () => {
      appMock.getAppMetrics.mockImplementationOnce(() => {
        throw new Error("fail");
      });
      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("system:get-app-metrics");
      const result = handler() as { totalMemoryMB: number; unavailable?: true };

      expect(result.unavailable).toBe(true);
      expect(result.totalMemoryMB).toBe(0);
    });

    it("uses workingSetSize even when privateBytes is populated (no ?? regression)", () => {
      // Simulate a Windows-shaped reading where privateBytes is large and would
      // win under the old `privateBytes ?? workingSetSize`. The handler must
      // still report workingSetSize so the metric is consistent cross-platform.
      appMock.getAppMetrics.mockImplementationOnce(() => [
        {
          pid: 1,
          type: "Browser",
          name: "Browser",
          memory: { privateBytes: 1024 * 1024, workingSetSize: 102400 },
          cpu: { percentCPUUsage: 1 },
        },
      ]);
      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("system:get-app-metrics");
      const result = handler() as { totalMemoryMB: number };

      // workingSetSize 102400 / 1024 = 100 MB, not privateBytes 1048576 / 1024 = 1024 MB.
      expect(result.totalMemoryMB).toBe(100);
    });
  });

  describe("handleGetHeapStats", () => {
    it("returns heap statistics with correct calculations", () => {
      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("diagnostics:get-heap-stats");
      const result = handler() as {
        usedMB: number;
        limitMB: number;
        percent: number;
        externalMB: number;
      };

      expect(result.limitMB).toBe(4096);
      expect(result.usedMB).toBeGreaterThan(0);
      expect(result.percent).toBeGreaterThan(0);
      expect(result.percent).toBeLessThan(100);
      expect(typeof result.externalMB).toBe("number");
    });
  });

  describe("handleGetDiagnosticsInfo", () => {
    it("returns uptime and event loop lag", () => {
      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("diagnostics:get-info");
      const result = handler() as { uptimeSeconds: number; eventLoopP99Ms: number };

      expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(result.eventLoopP99Ms).toBe(12);
    });
  });

  describe("handleCollectDiagnosticsForReview", () => {
    it("includes a positive appLaunchTimestamp in the review payload", async () => {
      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("system:collect-diagnostics-for-review");
      const result = (await handler()) as {
        appLaunchTimestamp: number;
        sectionKeys: string[];
      };

      expect(typeof result.appLaunchTimestamp).toBe("number");
      expect(result.appLaunchTimestamp).toBeGreaterThan(0);
      expect(result.appLaunchTimestamp).toBeLessThanOrEqual(Date.now());
      expect(result.sectionKeys).toEqual(["metadata"]);
    });
  });

  describe("save-bundle time window", () => {
    const logPath = (file: string) => path.normalize(path.join("/logs", file));
    const readPaths = () =>
      readFileMock.mock.calls.map((c: unknown[]) => path.normalize(c[0] as string));

    it("skips rotated logs whose mtime predates the window, keeps recent ones", async () => {
      existsSyncMock.mockImplementation(
        (p: string): boolean =>
          path.normalize(p) === logPath("daintree.log") ||
          path.normalize(p) === logPath("daintree.log.1") ||
          path.normalize(p) === logPath("daintree.log.2")
      );
      // Window cutoff = 5000ms. .1 is older (skip), .2 is newer (keep).
      statMock.mockImplementation((p: string): Promise<{ mtimeMs: number }> =>
        Promise.resolve({
          mtimeMs: path.normalize(p) === logPath("daintree.log.1") ? 4000 : 6000,
        })
      );
      dialogMock.showSaveDialog.mockResolvedValueOnce({
        filePath: "/tmp/diagnostics.zip",
        canceled: false,
      });

      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("system:save-diagnostics-bundle");
      await handler(
        {},
        {
          payload: { metadata: {} },
          enabledSections: { metadata: true, logs: true },
          replacements: [],
          timeWindowStartMs: 5000,
        }
      );

      const paths = readPaths();
      expect(paths).toContain(logPath("daintree.log"));
      expect(paths).toContain(logPath("daintree.log.2"));
      expect(paths).not.toContain(logPath("daintree.log.1"));
    });

    it("includes all rotated logs and never stats them when the window is full history", async () => {
      existsSyncMock.mockImplementation(
        (p: string): boolean =>
          path.normalize(p) === logPath("daintree.log") ||
          path.normalize(p) === logPath("daintree.log.1") ||
          path.normalize(p) === logPath("daintree.log.2")
      );
      dialogMock.showSaveDialog.mockResolvedValueOnce({
        filePath: "/tmp/diagnostics.zip",
        canceled: false,
      });

      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("system:save-diagnostics-bundle");
      await handler(
        {},
        {
          payload: { metadata: {} },
          enabledSections: { metadata: true, logs: true },
          replacements: [],
          timeWindowStartMs: null,
        }
      );

      const paths = readPaths();
      expect(paths).toContain(logPath("daintree.log.1"));
      expect(paths).toContain(logPath("daintree.log.2"));
      expect(statMock).not.toHaveBeenCalled();
    });

    it("includes a rotated log when its stat fails rather than dropping it", async () => {
      existsSyncMock.mockImplementation(
        (p: string): boolean =>
          path.normalize(p) === logPath("daintree.log") ||
          path.normalize(p) === logPath("daintree.log.1")
      );
      statMock.mockRejectedValue(new Error("stat failed"));
      dialogMock.showSaveDialog.mockResolvedValueOnce({
        filePath: "/tmp/diagnostics.zip",
        canceled: false,
      });

      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("system:save-diagnostics-bundle");
      await handler(
        {},
        {
          payload: { metadata: {} },
          enabledSections: { metadata: true, logs: true },
          replacements: [],
          timeWindowStartMs: 5000,
        }
      );

      expect(readPaths()).toContain(logPath("daintree.log.1"));
    });
  });

  describe("handleReportRendererElu", () => {
    function makeEvent(senderId = 42, destroyed = false) {
      return {
        sender: { id: senderId, isDestroyed: () => destroyed },
      };
    }

    it("records ELU samples for live senders, taking webContentsId from event.sender", () => {
      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("system:report-renderer-elu");
      handler(makeEvent(42), { requestId: "elu-1", blockingDurationMs: 800, sampleWindowMs: 1000 });

      expect(recordEluSampleMock).toHaveBeenCalledWith(42, {
        blockingDurationMs: 800,
        sampleWindowMs: 1000,
      });
    });

    it("rejects malformed payloads (NaN, non-positive window, negative blocking, null/missing)", () => {
      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("system:report-renderer-elu");

      // NaN blocking duration
      handler(makeEvent(42), {
        requestId: "x",
        blockingDurationMs: Number.NaN,
        sampleWindowMs: 1000,
      });
      // Zero window
      handler(makeEvent(42), { requestId: "x", blockingDurationMs: 0, sampleWindowMs: 0 });
      // Negative blocking
      handler(makeEvent(42), { requestId: "x", blockingDurationMs: -1, sampleWindowMs: 1000 });
      // Null payload
      handler(makeEvent(42), null);
      // Missing blockingDurationMs (undefined coerces to NaN through Number.isFinite)
      handler(makeEvent(42), { requestId: "x", sampleWindowMs: 1000 });
      // Missing sampleWindowMs
      handler(makeEvent(42), { requestId: "x", blockingDurationMs: 500 });

      expect(recordEluSampleMock).not.toHaveBeenCalled();
    });

    it("drops late replies from destroyed senders", () => {
      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("system:report-renderer-elu");
      handler(makeEvent(42, true), {
        requestId: "elu-1",
        blockingDurationMs: 500,
        sampleWindowMs: 1000,
      });
      expect(recordEluSampleMock).not.toHaveBeenCalled();
    });
  });

  describe("diagnostics file write modes", () => {
    it("JSON_EXPORT_USES_0o600_ATOMIC_WRITE", async () => {
      dialogMock.showSaveDialog.mockResolvedValueOnce({
        filePath: "/tmp/diagnostics.json",
        canceled: false,
      });
      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("system:download-diagnostics");

      const result = (await handler()) as boolean;

      expect(result).toBe(true);
      expect(resilientAtomicWriteFileMock).toHaveBeenCalledTimes(1);
      const [filePath, , encoding, options] = resilientAtomicWriteFileMock.mock
        .calls[0] as unknown[];
      expect(filePath).toBe("/tmp/diagnostics.json");
      expect(encoding).toBe("utf-8");
      expect(options).toEqual({ mode: 0o600 });
    });

    it("JSON_EXPORT_RESPECTS_DIALOG_CANCEL", async () => {
      dialogMock.showSaveDialog.mockResolvedValueOnce({
        filePath: undefined,
        canceled: true,
      });
      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("system:download-diagnostics");

      const result = (await handler()) as boolean;

      expect(result).toBe(false);
      expect(resilientAtomicWriteFileMock).not.toHaveBeenCalled();
    });

    it("ZIP_BUNDLE_USES_0o600_MODE", async () => {
      dialogMock.showSaveDialog.mockResolvedValueOnce({
        filePath: "/tmp/diagnostics.zip",
        canceled: false,
      });
      registerDiagnosticsHandlers(deps);
      const handler = getHandlerFn("system:save-diagnostics-bundle");

      const result = (await handler(
        {},
        {
          payload: { metadata: {} },
          enabledSections: { metadata: true, logs: false },
          replacements: [],
        }
      )) as boolean;

      expect(result).toBe(true);
      expect(createWriteStreamMock).toHaveBeenCalledTimes(1);
      const [zipPath, options] = createWriteStreamMock.mock.calls[0] as unknown[];
      expect(zipPath).toBe("/tmp/diagnostics.zip");
      expect(options).toEqual({ mode: 0o600 });
      expect(shellMock.showItemInFolder).toHaveBeenCalledWith("/tmp/diagnostics.zip");
    });

    it("ZIP_BUNDLE_CHMODS_AFTER_CLOSE_FOR_OVERWRITE_CASE", async () => {
      // createWriteStream's `mode` is only applied to newly-created files;
      // overwrite of an existing 0o644 file would otherwise preserve that mode.
      // The handler must explicitly chmod after close on POSIX platforms.
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      try {
        dialogMock.showSaveDialog.mockResolvedValueOnce({
          filePath: "/tmp/diagnostics-overwrite.zip",
          canceled: false,
        });
        registerDiagnosticsHandlers(deps);
        const handler = getHandlerFn("system:save-diagnostics-bundle");

        await handler(
          {},
          {
            payload: { metadata: {} },
            enabledSections: { metadata: true, logs: false },
            replacements: [],
          }
        );

        expect(chmodMock).toHaveBeenCalledWith("/tmp/diagnostics-overwrite.zip", 0o600);
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      }
    });

    it("ZIP_BUNDLE_SKIPS_CHMOD_ON_WINDOWS", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        dialogMock.showSaveDialog.mockResolvedValueOnce({
          filePath: "C:/Users/Public/diagnostics.zip",
          canceled: false,
        });
        registerDiagnosticsHandlers(deps);
        const handler = getHandlerFn("system:save-diagnostics-bundle");

        await handler(
          {},
          {
            payload: { metadata: {} },
            enabledSections: { metadata: true, logs: false },
            replacements: [],
          }
        );

        expect(chmodMock).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      }
    });
  });

  describe("renderer CPU profile", () => {
    const PROFILE_FIXTURE = { nodes: [], startTime: 0, endTime: 15, samples: [1, 2] };

    function makeProfilerEvent(id: number) {
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      const sendCommand = vi.fn((method: string) => {
        if (method === "Profiler.stop") return Promise.resolve({ profile: PROFILE_FIXTURE });
        return Promise.resolve({});
      });
      const sender = {
        id,
        isDestroyed: vi.fn(() => false),
        once: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
          (listeners[`wc:${event}`] ??= []).push(fn);
        }),
        removeListener: vi.fn(),
        debugger: {
          isAttached: vi.fn(() => false),
          attach: vi.fn(),
          sendCommand,
          on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
            (listeners[`dbg:${event}`] ??= []).push(fn);
          }),
          removeListener: vi.fn(),
        },
      };
      const emit = (key: string, ...args: unknown[]) => {
        listeners[key]?.forEach((fn) => fn(...args));
      };
      return { event: { sender }, sender, sendCommand, emit };
    }

    function profilerStopCalls(sendCommand: ReturnType<typeof vi.fn>): number {
      return sendCommand.mock.calls.filter((c: unknown[]) => c[0] === "Profiler.stop").length;
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("start attaches the debugger and sends Profiler commands in order", async () => {
      const { event, sender, sendCommand } = makeProfilerEvent(701);
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");

      const result = (await start(event)) as { status: string; expiresAt: number };

      expect(result.status).toBe("started");
      expect(result.expiresAt).toBeGreaterThan(Date.now());
      expect(sender.debugger.attach).toHaveBeenCalledWith("1.3");
      expect(sendCommand.mock.calls.map((c: unknown[]) => c[0])).toEqual([
        "Profiler.enable",
        "Profiler.setSamplingInterval",
        "Profiler.start",
      ]);
      expect(sendCommand).toHaveBeenCalledWith("Profiler.setSamplingInterval", { interval: 1000 });
    });

    it("does not re-attach when the debugger is already attached", async () => {
      const { event, sender } = makeProfilerEvent(702);
      sender.debugger.isAttached.mockReturnValue(true);
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");

      await start(event);

      expect(sender.debugger.attach).not.toHaveBeenCalled();
    });

    it("duplicate start while recording returns already-recording", async () => {
      const { event } = makeProfilerEvent(703);
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");

      await start(event);
      const second = (await start(event)) as { status: string; reason: string };

      expect(second).toEqual({ status: "failed", reason: "already-recording" });
    });

    it("start on a destroyed sender fails without CDP calls", async () => {
      const { event, sender, sendCommand } = makeProfilerEvent(704);
      sender.isDestroyed.mockReturnValue(true);
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");

      const result = await start(event);

      expect(result).toEqual({ status: "failed", reason: "webcontents-destroyed" });
      expect(sendCommand).not.toHaveBeenCalled();
    });

    it("stop without a recording returns not-recording", async () => {
      const { event } = makeProfilerEvent(705);
      registerDiagnosticsHandlers(deps);
      const stop = getHandlerFn("system:renderer-cpu-profile-stop");

      const result = await stop(event);

      expect(result).toEqual({ status: "failed", reason: "not-recording" });
    });

    it("stop writes the raw profile JSON to a .cpuprofile path and reveals it", async () => {
      const { event } = makeProfilerEvent(706);
      dialogMock.showSaveDialog.mockResolvedValueOnce({
        filePath: "/tmp/profile.cpuprofile",
        canceled: false,
      });
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");
      const stop = getHandlerFn("system:renderer-cpu-profile-stop");

      await start(event);
      const result = await stop(event);

      expect(result).toEqual({ status: "saved" });
      const dialogArgs = dialogMock.showSaveDialog.mock.calls[0] as unknown[];
      const opts = dialogArgs[dialogArgs.length - 1] as {
        defaultPath: string;
        filters: Array<{ extensions: string[] }>;
      };
      expect(opts.defaultPath).toMatch(/^daintree-renderer-profile-.+\.cpuprofile$/);
      expect(opts.filters[0].extensions).toEqual(["cpuprofile"]);
      expect(resilientAtomicWriteFileMock).toHaveBeenCalledWith(
        "/tmp/profile.cpuprofile",
        JSON.stringify(PROFILE_FIXTURE),
        "utf-8",
        { mode: 0o600 }
      );
      expect(shellMock.showItemInFolder).toHaveBeenCalledWith("/tmp/profile.cpuprofile");
    });

    it("dialog cancel returns canceled without writing", async () => {
      const { event } = makeProfilerEvent(707);
      dialogMock.showSaveDialog.mockResolvedValueOnce({ filePath: undefined, canceled: true });
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");
      const stop = getHandlerFn("system:renderer-cpu-profile-stop");

      await start(event);
      const result = await stop(event);

      expect(result).toEqual({ status: "canceled" });
      expect(resilientAtomicWriteFileMock).not.toHaveBeenCalled();
      expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
    });

    it("manual stop clears the auto-stop timer", async () => {
      const { event, sendCommand } = makeProfilerEvent(708);
      dialogMock.showSaveDialog.mockResolvedValueOnce({ filePath: undefined, canceled: true });
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");
      const stop = getHandlerFn("system:renderer-cpu-profile-stop");

      await start(event);
      await stop(event);
      await vi.advanceTimersByTimeAsync(20_000);

      expect(profilerStopCalls(sendCommand)).toBe(1);
    });

    it("auto-stop captures at 15s; a later stop saves it without a second Profiler.stop", async () => {
      const { event, sendCommand } = makeProfilerEvent(709);
      dialogMock.showSaveDialog.mockResolvedValueOnce({
        filePath: "/tmp/auto.cpuprofile",
        canceled: false,
      });
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");
      const stop = getHandlerFn("system:renderer-cpu-profile-stop");

      await start(event);
      expect(profilerStopCalls(sendCommand)).toBe(0);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(profilerStopCalls(sendCommand)).toBe(1);

      const result = await stop(event);

      expect(result).toEqual({ status: "saved" });
      expect(profilerStopCalls(sendCommand)).toBe(1);
      expect(resilientAtomicWriteFileMock).toHaveBeenCalledWith(
        "/tmp/auto.cpuprofile",
        JSON.stringify(PROFILE_FIXTURE),
        "utf-8",
        { mode: 0o600 }
      );
    });

    it("detach during recording fails the stop and cancels the auto-stop", async () => {
      const { event, sendCommand, emit } = makeProfilerEvent(710);
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");
      const stop = getHandlerFn("system:renderer-cpu-profile-stop");

      await start(event);
      emit("dbg:detach");
      const result = (await stop(event)) as { status: string; reason: string };

      expect(result.status).toBe("failed");
      expect(result.reason).toBe("devtools-detached");
      expect(resilientAtomicWriteFileMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(profilerStopCalls(sendCommand)).toBe(0);
    });

    it("start after an uncollected auto-stopped session records again", async () => {
      const { event, sendCommand } = makeProfilerEvent(711);
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");

      await start(event);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(profilerStopCalls(sendCommand)).toBe(1);

      const second = (await start(event)) as { status: string };

      expect(second.status).toBe("started");
      expect(
        sendCommand.mock.calls.filter((c: unknown[]) => c[0] === "Profiler.start")
      ).toHaveLength(2);
    });

    it("a discarded session's in-flight capture never disables the profiler for a new recording", async () => {
      const { event, sendCommand } = makeProfilerEvent(713);
      let resolveStop: ((value: unknown) => void) | undefined;
      sendCommand.mockImplementation(((method: string) => {
        if (method === "Profiler.stop") {
          return new Promise<unknown>((resolve) => {
            resolveStop = resolve;
          });
        }
        return Promise.resolve({});
      }) as (method: string) => Promise<Record<string, unknown>>);
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");

      await start(event);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(profilerStopCalls(sendCommand)).toBe(1);

      const second = (await start(event)) as { status: string };
      expect(second.status).toBe("started");

      resolveStop?.({ profile: PROFILE_FIXTURE });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const disables = sendCommand.mock.calls.filter((c: unknown[]) => c[0] === "Profiler.disable");
      expect(disables).toHaveLength(0);
    });

    it("partial CDP start failure disables the profiler and leaves no session", async () => {
      const { event, sendCommand } = makeProfilerEvent(714);
      sendCommand.mockImplementation((method: string) => {
        if (method === "Profiler.start") return Promise.reject(new Error("boom"));
        if (method === "Profiler.stop") return Promise.resolve({ profile: PROFILE_FIXTURE });
        return Promise.resolve({});
      });
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");
      const stop = getHandlerFn("system:renderer-cpu-profile-stop");

      const result = (await start(event)) as { status: string; reason: string };

      expect(result.status).toBe("failed");
      expect(result.reason).toBe("cdp-error");
      expect(sendCommand).toHaveBeenCalledWith("Profiler.disable");
      expect(await stop(event)).toEqual({ status: "failed", reason: "not-recording" });

      sendCommand.mockImplementation((method: string) =>
        method === "Profiler.stop"
          ? Promise.resolve({ profile: PROFILE_FIXTURE })
          : Promise.resolve({})
      );
      const retry = (await start(event)) as { status: string };
      expect(retry.status).toBe("started");
    });

    it("write failure returns save-failed without revealing, then allows re-recording", async () => {
      const { event } = makeProfilerEvent(715);
      dialogMock.showSaveDialog.mockResolvedValueOnce({
        filePath: "/tmp/fail.cpuprofile",
        canceled: false,
      });
      resilientAtomicWriteFileMock.mockRejectedValueOnce(new Error("disk full"));
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");
      const stop = getHandlerFn("system:renderer-cpu-profile-stop");

      await start(event);
      const result = (await stop(event)) as { status: string; reason: string };

      expect(result.status).toBe("failed");
      expect(result.reason).toBe("save-failed");
      expect(shellMock.showItemInFolder).not.toHaveBeenCalled();

      const retry = (await start(event)) as { status: string };
      expect(retry.status).toBe("started");
    });

    it("sessions are isolated per webContents", async () => {
      const a = makeProfilerEvent(716);
      const b = makeProfilerEvent(717);
      dialogMock.showSaveDialog.mockResolvedValue({ filePath: undefined, canceled: true });
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");
      const stop = getHandlerFn("system:renderer-cpu-profile-stop");

      await start(a.event);
      await start(b.event);

      expect(await stop(a.event)).toEqual({ status: "canceled" });
      expect(await stop(a.event)).toEqual({ status: "failed", reason: "not-recording" });
      expect(await stop(b.event)).toEqual({ status: "canceled" });
    });

    it("destroyed event cleans up the session so stop reports not-recording", async () => {
      const { event, emit } = makeProfilerEvent(712);
      registerDiagnosticsHandlers(deps);
      const start = getHandlerFn("system:renderer-cpu-profile-start");
      const stop = getHandlerFn("system:renderer-cpu-profile-stop");

      await start(event);
      emit("wc:destroyed");
      const result = await stop(event);

      expect(result).toEqual({ status: "failed", reason: "not-recording" });
    });
  });
});
