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
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { app } from "electron";
import v8 from "node:v8";
import { logDebug, logInfo, logWarn } from "../../utils/logger.js";
import {
  startAppMetricsMonitor,
  WARMUP_INTERVALS,
  PRESSURE_COUNT_TIER2,
  MITIGATION_COOLDOWN_MS,
  type MemoryPressureActions,
} from "../ProcessMemoryMonitor.js";

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
    const baseMb = 100;
    const growthPerTickMb = 0.1; // ~6 MB/hr
    let tick = 0;

    mockGetAppMetrics.mockImplementation(() => {
      const mb = baseMb + tick * growthPerTickMb;
      tick++;
      return [makeMetric("Tab", mb * 1024, 500, mb * 1024)];
    });

    stop = startAppMetricsMonitor();

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
    const baseKB = 100 * 1024;
    const spikeKB = 200 * 1024;
    let tick = 0;

    mockGetAppMetrics.mockImplementation(() => {
      const kb = tick % 2 === 0 ? spikeKB : baseKB;
      tick++;
      return [makeMetric("Tab", kb, 500, kb)];
    });

    stop = startAppMetricsMonitor();

    vi.advanceTimersByTime(62 * 30_000);

    const trendCalls = vi
      .mocked(logWarn)
      .mock.calls.filter((c) => c[0] === "process-memory-trend-warning");
    expect(trendCalls).toHaveLength(0);
  });

  it("prunes trend state for PIDs that are no longer reported", () => {
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 500)]);

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 600)]);
    vi.advanceTimersByTime(30_000);

    expect(logDebug).toHaveBeenCalledWith("process-memory-sample", {
      pid: 600,
      type: "Browser",
      mb: 200,
    });
  });

  describe("memory pressure mitigation", () => {
    let mockActions: MemoryPressureActions;

    beforeEach(() => {
      mockActions = {
        clearCaches: vi.fn().mockResolvedValue(undefined),
        hibernateIdleProjects: vi.fn().mockResolvedValue(undefined),
      };
    });

    async function advancePolls(n: number): Promise<void> {
      for (let i = 0; i < n; i++) {
        vi.advanceTimersByTime(30_000);
      }
      await vi.advanceTimersByTimeAsync(0);
    }

    it("works without actions parameter (backward compat)", () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor();
      vi.advanceTimersByTime(30_000 * 10);
      // No crash, no mitigation called
    });

    it("does not call clearCaches during warmup period", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS);

      expect(mockActions.clearCaches).not.toHaveBeenCalled();
    });

    it("calls clearCaches on first pressure poll after warmup", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      // Advance past warmup
      await advancePolls(WARMUP_INTERVALS + 1);

      expect(mockActions.clearCaches).toHaveBeenCalledTimes(1);
    });

    it("does not call hibernateIdleProjects before sustained pressure threshold", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      // Warmup + pressure count less than tier2
      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2 - 1);

      expect(mockActions.hibernateIdleProjects).not.toHaveBeenCalled();
    });

    it("calls hibernateIdleProjects after sustained pressure threshold", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);

      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(1);
    });

    it("resets consecutive pressure count when pressure subsides", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      // Past warmup + 2 pressure polls
      await advancePolls(WARMUP_INTERVALS + 2);

      // Drop below threshold
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 100)]);
      await advancePolls(1);

      // Resume pressure — should restart count from 0
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      await advancePolls(PRESSURE_COUNT_TIER2 - 1);

      expect(mockActions.hibernateIdleProjects).not.toHaveBeenCalled();
    });

    it("respects tier 2 cooldown — no re-trigger within cooldown period", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      // Trigger tier 2
      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);
      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(1);

      // Continue pressure — should not trigger again within cooldown
      await advancePolls(PRESSURE_COUNT_TIER2);
      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(1);
    });

    it("allows tier 2 re-trigger after cooldown expires", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      // Trigger tier 2
      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);
      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(1);

      // Advance past cooldown (keep pressure)
      const cooldownPolls = Math.ceil(MITIGATION_COOLDOWN_MS / 30_000);
      await advancePolls(cooldownPolls + 1);

      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(2);
    });

    it("logs tier 1 and tier 2 mitigation events", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);

      expect(logInfo).toHaveBeenCalledWith("memory-pressure-tier1-mitigation", expect.any(Object));
      expect(logInfo).toHaveBeenCalledWith("memory-pressure-tier2-mitigation", expect.any(Object));
    });

    it("does not trigger mitigation when no process exceeds threshold", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2 + 5);

      expect(mockActions.clearCaches).not.toHaveBeenCalled();
      expect(mockActions.hibernateIdleProjects).not.toHaveBeenCalled();
    });
  });
});
