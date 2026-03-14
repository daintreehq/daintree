import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppMetrics: vi.fn(),
    isPackaged: false,
    getPath: vi.fn().mockReturnValue("/tmp/test-logs"),
  },
}));

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
}));

vi.mock("node:v8", () => ({
  default: {
    writeHeapSnapshot: vi.fn().mockReturnValue("/tmp/test-logs/heap-123-1000.heapsnapshot"),
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

import { app } from "electron";
import v8 from "node:v8";
import { logDebug, logWarn } from "../../utils/logger.js";
import { startAppMetricsMonitor } from "../ProcessMemoryMonitor.js";

const mockGetAppMetrics = app.getAppMetrics as ReturnType<typeof vi.fn>;

function makeMetric(type: string, workingSetSizeKB: number, pid = 1000): Electron.ProcessMetric {
  return {
    type,
    pid,
    creationTime: Date.now(),
    memory: {
      workingSetSize: workingSetSizeKB,
      peakWorkingSetSize: workingSetSizeKB,
    },
    sandboxed: false,
    integrityLevel: "unknown",
    cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
  } as Electron.ProcessMetric;
}

describe("ProcessMemoryMonitor", () => {
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetAppMetrics.mockReturnValue([]);
  });

  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    Object.defineProperty(app, "isPackaged", { value: false, writable: true });
  });

  it("logs debug samples for monitored process types", () => {
    mockGetAppMetrics.mockReturnValue([
      makeMetric("Browser", 200 * 1024, 100),
      makeMetric("Tab", 500 * 1024, 200),
      makeMetric("Utility", 100 * 1024, 300),
    ]);

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    expect(logDebug).toHaveBeenCalledTimes(3);
    expect(logDebug).toHaveBeenCalledWith("process-memory-sample", {
      pid: 100,
      type: "Browser",
      mb: 200,
    });
    expect(logDebug).toHaveBeenCalledWith("process-memory-sample", {
      pid: 200,
      type: "Tab",
      mb: 500,
    });
    expect(logDebug).toHaveBeenCalledWith("process-memory-sample", {
      pid: 300,
      type: "Utility",
      mb: 100,
    });
  });

  it("skips unmonitored process types (GPU, Zygote, etc.)", () => {
    mockGetAppMetrics.mockReturnValue([
      makeMetric("GPU", 200 * 1024, 400),
      makeMetric("Zygote", 50 * 1024, 500),
    ]);

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    expect(logDebug).not.toHaveBeenCalled();
  });

  it("emits warn log when Browser exceeds 300 MB threshold", () => {
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    expect(logWarn).toHaveBeenCalledWith("process-memory-threshold-exceeded", {
      pid: 100,
      type: "Browser",
      mb: 350,
      thresholdMb: 300,
    });
  });

  it("emits warn log when Tab exceeds 1536 MB threshold", () => {
    mockGetAppMetrics.mockReturnValue([makeMetric("Tab", 1600 * 1024, 200)]);

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    expect(logWarn).toHaveBeenCalledWith("process-memory-threshold-exceeded", {
      pid: 200,
      type: "Tab",
      mb: 1600,
      thresholdMb: 1536,
    });
  });

  it("emits warn log when Utility exceeds 500 MB threshold", () => {
    mockGetAppMetrics.mockReturnValue([makeMetric("Utility", 600 * 1024, 300)]);

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    expect(logWarn).toHaveBeenCalledWith("process-memory-threshold-exceeded", {
      pid: 300,
      type: "Utility",
      mb: 600,
      thresholdMb: 500,
    });
  });

  it("does NOT warn when below threshold", () => {
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 100)]);

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    expect(logWarn).not.toHaveBeenCalled();
  });

  it("writes heap snapshot when Browser exceeds critical threshold in dev mode", () => {
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700 * 1024, 100)]);
    Object.defineProperty(app, "isPackaged", { value: false, writable: true });

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    expect(v8.writeHeapSnapshot).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith("heap-snapshot-written", {
      path: "/tmp/test-logs/heap-123-1000.heapsnapshot",
    });
  });

  it("does NOT write heap snapshot in packaged mode", () => {
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700 * 1024, 100)]);
    Object.defineProperty(app, "isPackaged", { value: true, writable: true });

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    expect(v8.writeHeapSnapshot).not.toHaveBeenCalled();
  });

  it("respects snapshot cooldown — no double-write within 5 minutes", () => {
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700 * 1024, 100)]);
    Object.defineProperty(app, "isPackaged", { value: false, writable: true });

    stop = startAppMetricsMonitor();

    vi.advanceTimersByTime(30_000);
    expect(v8.writeHeapSnapshot).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(v8.writeHeapSnapshot).toHaveBeenCalledTimes(1);
  });

  it("allows another snapshot after cooldown expires", () => {
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700 * 1024, 100)]);
    Object.defineProperty(app, "isPackaged", { value: false, writable: true });

    stop = startAppMetricsMonitor();

    vi.advanceTimersByTime(30_000);
    expect(v8.writeHeapSnapshot).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 30_000);
    expect(v8.writeHeapSnapshot).toHaveBeenCalledTimes(2);
  });

  it("catches and logs snapshot errors without consuming cooldown", () => {
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700 * 1024, 100)]);
    Object.defineProperty(app, "isPackaged", { value: false, writable: true });
    vi.mocked(v8.writeHeapSnapshot).mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    expect(logWarn).toHaveBeenCalledWith("heap-snapshot-failed", {
      error: "Error: disk full",
    });

    // Next tick should retry since cooldown was not consumed
    vi.advanceTimersByTime(30_000);
    expect(v8.writeHeapSnapshot).toHaveBeenCalledTimes(2);
  });

  it("cooldown is per-PID — different PIDs get independent snapshots", () => {
    mockGetAppMetrics.mockReturnValue([
      makeMetric("Browser", 700 * 1024, 100),
      makeMetric("Browser", 700 * 1024, 200),
    ]);
    Object.defineProperty(app, "isPackaged", { value: false, writable: true });

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    expect(v8.writeHeapSnapshot).toHaveBeenCalledTimes(2);
  });

  it("catches and logs polling errors without crashing", () => {
    mockGetAppMetrics.mockImplementationOnce(() => {
      throw new Error("metrics unavailable");
    });

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    expect(logWarn).toHaveBeenCalledWith("process-memory-poll-failed", {
      error: "Error: metrics unavailable",
    });
  });

  it("stop closure halts sampling", () => {
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 100)]);

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);
    expect(logDebug).toHaveBeenCalledTimes(1);

    stop();
    vi.advanceTimersByTime(60_000);
    expect(logDebug).toHaveBeenCalledTimes(1);
  });
});
