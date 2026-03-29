import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const dialogMock = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
}));

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
  monitorEventLoopDelay: () => ({
    enable: vi.fn(),
    disable: vi.fn(),
    percentile: () => 12_000_000,
    reset: vi.fn(),
  }),
}));

vi.mock("../../../services/DiagnosticsCollector.js", () => ({
  collectDiagnostics: vi.fn(() => Promise.resolve({})),
}));

import { registerDiagnosticsHandlers } from "../diagnostics.js";

function getHandlerFn(channelName: string): (...args: unknown[]) => unknown {
  const call = ipcMainMock.handle.mock.calls.find(
    (c: unknown[]) => c[0] === channelName
  );
  if (!call) throw new Error(`No handler registered for ${channelName}`);
  return call[1] as (...args: unknown[]) => unknown;
}

describe("registerDiagnosticsHandlers", () => {
  const deps = { mainWindow: {} } as Parameters<typeof registerDiagnosticsHandlers>[0];

  beforeEach(() => {
    vi.clearAllMocks();
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
});
