import { describe, it, expect, vi, beforeEach } from "vitest";

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

const appMock = vi.hoisted(() => ({
  getAppMetrics: vi.fn(() => [
    {
      pid: 100,
      type: "Browser",
      name: "Browser",
      memory: { privateBytes: 102400, workingSetSize: 204800 },
      cpu: { percentCPUUsage: 5.5 },
    },
    {
      pid: 200,
      type: "GPU",
      name: "GPU Process",
      memory: { privateBytes: undefined, workingSetSize: 51200 },
      cpu: { percentCPUUsage: 2.3 },
    },
    {
      pid: 300,
      type: "Utility",
      name: "Network Service",
      memory: { privateBytes: 30720, workingSetSize: 40960 },
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

import { registerDiagnosticsHandlers } from "../diagnostics.js";

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
      expect(result[0].pid).toBe(100);
      expect(result[0].memoryMB).toBe(100);
      expect(result[0].cpuPercent).toBe(5.5);
      expect(result[0].name).toBe("Browser");

      // Falls back to workingSetSize when privateBytes is undefined
      expect(result[1].pid).toBe(200);
      expect(result[1].memoryMB).toBe(50);

      // CPU defaults to 0 when cpu is undefined
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
    const readPaths = () => readFileMock.mock.calls.map((c: unknown[]) => c[0] as string);

    it("skips rotated logs whose mtime predates the window, keeps recent ones", async () => {
      existsSyncMock.mockImplementation(
        (p: string): boolean =>
          p === "/logs/daintree.log" || p === "/logs/daintree.log.1" || p === "/logs/daintree.log.2"
      );
      // Window cutoff = 5000ms. .1 is older (skip), .2 is newer (keep).
      statMock.mockImplementation(
        (p: string): Promise<{ mtimeMs: number }> =>
          Promise.resolve({ mtimeMs: p === "/logs/daintree.log.1" ? 4000 : 6000 })
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
      expect(paths).toContain("/logs/daintree.log");
      expect(paths).toContain("/logs/daintree.log.2");
      expect(paths).not.toContain("/logs/daintree.log.1");
    });

    it("includes all rotated logs and never stats them when the window is full history", async () => {
      existsSyncMock.mockImplementation(
        (p: string): boolean =>
          p === "/logs/daintree.log" || p === "/logs/daintree.log.1" || p === "/logs/daintree.log.2"
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
      expect(paths).toContain("/logs/daintree.log.1");
      expect(paths).toContain("/logs/daintree.log.2");
      expect(statMock).not.toHaveBeenCalled();
    });

    it("includes a rotated log when its stat fails rather than dropping it", async () => {
      existsSyncMock.mockImplementation(
        (p: string): boolean => p === "/logs/daintree.log" || p === "/logs/daintree.log.1"
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

      expect(readPaths()).toContain("/logs/daintree.log.1");
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
});
