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

function makeMetric(
  type: string,
  workingSetSizeKB: number,
  pid = 1000,
  privateBytesKB?: number
): Electron.ProcessMetric {
  return {
    type,
    pid,
    creationTime: Date.now(),
    memory: {
      workingSetSize: workingSetSizeKB,
      peakWorkingSetSize: workingSetSizeKB,
      ...(privateBytesKB !== undefined ? { privateBytes: privateBytesKB } : {}),
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

  // --- New tests for privateBytes and trend detection ---

  it("prefers privateBytes over workingSetSize when available", () => {
    // privateBytes = 350 MB, workingSetSize = 100 MB — should use 350 MB
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 100 * 1024, 100, 350 * 1024)]);

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    expect(logWarn).toHaveBeenCalledWith("process-memory-threshold-exceeded", {
      pid: 100,
      type: "Browser",
      mb: 350,
      thresholdMb: 300,
    });
  });

  it("falls back to workingSetSize when privateBytes is not available", () => {
    // No privateBytes supplied — should use workingSetSize of 600 MB
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

  it("emits trend warning after sustained growth exceeding 5 MB/hr", () => {
    // Simulate steady growth over 31 minutes (62 ticks × 30s)
    // Start at 100 MB, grow ~3 MB per 60s bucket = ~180 MB/hr... too fast.
    // We want growth just above threshold: 5 MB/hr = 2.5 MB per 30 min window
    // Start at 100 MB, grow 0.1 MB per tick → 6.2 MB over 62 ticks (31 min)
    // Per 0.5 hours that's ~6 MB/hr > 5 MB/hr threshold
    const baseMb = 100;
    const growthPerTickMb = 0.1; // ~6 MB/hr
    let tick = 0;

    mockGetAppMetrics.mockImplementation(() => {
      const mb = baseMb + tick * growthPerTickMb;
      tick++;
      return [makeMetric("Tab", mb * 1024, 500, mb * 1024)];
    });

    stop = startAppMetricsMonitor();

    // First bucket commits at tick 2, 30th at tick 60 (30 min).
    // At tick 60, emaHistory.length = 30 AND elapsed > 15 min — both suppression
    // gates pass and trend evaluation begins. We advance a bit past to be safe.

    vi.advanceTimersByTime(62 * 30_000); // 31 min

    const trendCalls = vi
      .mocked(logWarn)
      .mock.calls.filter((c) => c[0] === "process-memory-trend-warning");
    expect(trendCalls.length).toBeGreaterThanOrEqual(1);
    expect(trendCalls[0]![1]).toMatchObject({
      pid: 500,
      type: "Tab",
    });
    expect(
      (trendCalls[0]![1] as { growthMbPerHour: number }).growthMbPerHour
    ).toBeGreaterThanOrEqual(5);
  });

  it("suppresses trend warning before 30 buckets are accumulated", () => {
    // Rapid growth but only 14 minutes (28 ticks = 14 buckets).
    // Both suppression gates block: elapsed < 15 min AND buckets < 30.
    const baseMb = 100;
    const growthPerTickMb = 1;
    let tick = 0;

    mockGetAppMetrics.mockImplementation(() => {
      const mb = baseMb + tick * growthPerTickMb;
      tick++;
      return [makeMetric("Tab", mb * 1024, 500, mb * 1024)];
    });

    stop = startAppMetricsMonitor();

    vi.advanceTimersByTime(28 * 30_000);

    const trendCalls = vi
      .mocked(logWarn)
      .mock.calls.filter((c) => c[0] === "process-memory-trend-warning");
    expect(trendCalls).toHaveLength(0);
  });

  it("does not trigger trend warning when single-sample spikes are absorbed by bucket-minimum", () => {
    // Flat baseline of 100 MB but every odd tick spikes to 200 MB.
    // Bucket-minimum should always pick the baseline (100 MB), so EMA stays flat.
    const baseKB = 100 * 1024;
    const spikeKB = 200 * 1024;
    let tick = 0;

    mockGetAppMetrics.mockImplementation(() => {
      const kb = tick % 2 === 0 ? spikeKB : baseKB;
      tick++;
      return [makeMetric("Tab", kb, 500, kb)];
    });

    stop = startAppMetricsMonitor();

    // Run 62 ticks (31 min) — enough for full trend evaluation window
    vi.advanceTimersByTime(62 * 30_000);

    const trendCalls = vi
      .mocked(logWarn)
      .mock.calls.filter((c) => c[0] === "process-memory-trend-warning");
    expect(trendCalls).toHaveLength(0);
  });

  it("prunes trend state for PIDs that are no longer reported", () => {
    // Start with PID 500, then remove it
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 500)]);

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    // Now only PID 600 is returned — PID 500 should be pruned
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 600)]);
    vi.advanceTimersByTime(30_000);

    // Confirm new PID gets sampled (no crash from stale state)
    expect(logDebug).toHaveBeenCalledWith("process-memory-sample", {
      pid: 600,
      type: "Browser",
      mb: 200,
    });
  });
});
