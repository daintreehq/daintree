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
  recordBlinkSample,
  forgetBlinkSample,
  getBlinkSamples,
  recordEluSample,
  forgetEluSample,
  getEluSamples,
  getEluHighStreaks,
  RENDERER_ELU_HIGH_RATIO,
  RENDERER_ELU_HIGH_SAMPLE_COUNT,
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

  it("emits warn log when Tab exceeds 768 MB threshold", () => {
    mockGetAppMetrics.mockReturnValue([makeMetric("Tab", 800 * 1024, 200)]);

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    expect(logWarn).toHaveBeenCalledWith("process-memory-threshold-exceeded", {
      pid: 200,
      type: "Tab",
      mb: 800,
      thresholdMb: 768,
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
        destroyHiddenWebviews: vi.fn().mockResolvedValue(undefined),
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

    it("calls trimPtyHostState during tier 1 mitigation", async () => {
      const trimPtyHostState = vi.fn();
      const actionsWithTrim: MemoryPressureActions = {
        ...mockActions,
        trimPtyHostState,
      };
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(actionsWithTrim);

      await advancePolls(WARMUP_INTERVALS + 1);

      expect(trimPtyHostState).toHaveBeenCalledTimes(1);
    });

    it("continues tier 1 even if trimPtyHostState throws", async () => {
      const trimPtyHostState = vi.fn().mockImplementation(() => {
        throw new Error("trim failed");
      });
      const actionsWithTrim: MemoryPressureActions = {
        ...mockActions,
        trimPtyHostState,
      };
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(actionsWithTrim);

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);

      expect(trimPtyHostState).toHaveBeenCalled();
      expect(actionsWithTrim.hibernateIdleProjects).toHaveBeenCalledTimes(1);
    });

    it("calls destroyHiddenWebviews(1) on tier 1 mitigation", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + 1);

      expect(mockActions.destroyHiddenWebviews).toHaveBeenCalledWith(1);
    });

    it("calls destroyHiddenWebviews(2) on tier 2 mitigation", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);

      expect(mockActions.destroyHiddenWebviews).toHaveBeenCalledWith(2);
    });

    it("calls destroyHiddenWebviews before hibernateIdleProjects in tier 2", async () => {
      const callOrder: string[] = [];
      mockActions.destroyHiddenWebviews = vi.fn().mockImplementation(async () => {
        callOrder.push("destroyHiddenWebviews");
      });
      mockActions.hibernateIdleProjects = vi.fn().mockImplementation(async () => {
        callOrder.push("hibernateIdleProjects");
      });

      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);

      const destroyIdx = callOrder.lastIndexOf("destroyHiddenWebviews");
      const hibernateIdx = callOrder.indexOf("hibernateIdleProjects");
      expect(destroyIdx).toBeLessThan(hibernateIdx);
    });

    it("does not trigger mitigation when no process exceeds threshold", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2 + 5);

      expect(mockActions.clearCaches).not.toHaveBeenCalled();
      expect(mockActions.hibernateIdleProjects).not.toHaveBeenCalled();
    });
  });

  describe("blink memory sampling (issue #6272)", () => {
    beforeEach(() => {
      // Sample map is module-scoped; clear per-test so order doesn't matter.
      for (const wcId of Array.from(getBlinkSamples().keys())) {
        forgetBlinkSample(wcId);
      }
    });

    it("recordBlinkSample stores per-webContentsId payload (values in KB) and emits debug log", () => {
      // Electron's BlinkMemoryInfo reports kilobytes; 50 MB == 50*1024 KB.
      recordBlinkSample(42, {
        allocated: 50 * 1024,
        marked: 10 * 1024,
        total: 60 * 1024,
        partitionAlloc: 8 * 1024,
      });

      const stored = getBlinkSamples().get(42);
      expect(stored?.allocated).toBe(50 * 1024);
      expect(stored?.marked).toBe(10 * 1024);
      expect(stored?.total).toBe(60 * 1024);
      expect(stored?.partitionAlloc).toBe(8 * 1024);
      expect(typeof stored?.timestamp).toBe("number");

      expect(logDebug).toHaveBeenCalledWith(
        "blink-memory-sample",
        expect.objectContaining({ webContentsId: 42, allocatedMb: 50, totalMb: 60 })
      );
    });

    it("recordBlinkSample log conversion is KB → MB (regression for unit bug)", () => {
      // 512 MB worth of Blink memory == 512*1024 KB.
      recordBlinkSample(99, { allocated: 512 * 1024 });
      expect(logDebug).toHaveBeenCalledWith(
        "blink-memory-sample",
        expect.objectContaining({ webContentsId: 99, allocatedMb: 512 })
      );
    });

    it("recordBlinkSample overwrites the previous value for the same webContentsId", () => {
      recordBlinkSample(7, { allocated: 10 });
      recordBlinkSample(7, { allocated: 99 });
      expect(getBlinkSamples().get(7)?.allocated).toBe(99);
    });

    it("forgetBlinkSample removes the recorded sample (used by view eviction)", () => {
      recordBlinkSample(11, { allocated: 5 });
      expect(getBlinkSamples().has(11)).toBe(true);
      forgetBlinkSample(11);
      expect(getBlinkSamples().has(11)).toBe(false);
    });

    it("startAppMetricsMonitor invokes actions.sampleBlinkMemory once per poll", () => {
      const sampleBlinkMemory = vi.fn();
      const actions: MemoryPressureActions = {
        clearCaches: vi.fn().mockResolvedValue(undefined),
        destroyHiddenWebviews: vi.fn().mockResolvedValue(undefined),
        hibernateIdleProjects: vi.fn().mockResolvedValue(undefined),
        sampleBlinkMemory,
      };

      stop = startAppMetricsMonitor(actions);

      vi.advanceTimersByTime(30_000);
      expect(sampleBlinkMemory).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(30_000);
      expect(sampleBlinkMemory).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(30_000);
      expect(sampleBlinkMemory).toHaveBeenCalledTimes(3);
    });

    it("sampleBlinkMemory throwing does not break the poll loop", () => {
      const sampleBlinkMemory = vi.fn().mockImplementation(() => {
        throw new Error("renderer port closed");
      });
      const actions: MemoryPressureActions = {
        clearCaches: vi.fn().mockResolvedValue(undefined),
        destroyHiddenWebviews: vi.fn().mockResolvedValue(undefined),
        hibernateIdleProjects: vi.fn().mockResolvedValue(undefined),
        sampleBlinkMemory,
      };

      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 100)]);
      stop = startAppMetricsMonitor(actions);

      // Two consecutive polls — both should still log the debug sample even
      // though sampleBlinkMemory throws every time.
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);

      expect(sampleBlinkMemory).toHaveBeenCalledTimes(2);
      expect(logDebug).toHaveBeenCalledWith("process-memory-sample", expect.any(Object));
    });

    it("works without sampleBlinkMemory (optional field, backwards compat)", () => {
      const actions: MemoryPressureActions = {
        clearCaches: vi.fn().mockResolvedValue(undefined),
        destroyHiddenWebviews: vi.fn().mockResolvedValue(undefined),
        hibernateIdleProjects: vi.fn().mockResolvedValue(undefined),
      };

      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 100)]);
      stop = startAppMetricsMonitor(actions);

      // Should not throw — sampleBlinkMemory is optional.
      expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    });
  });

  describe("renderer ELU sampling (issue #6276)", () => {
    beforeEach(() => {
      for (const wcId of Array.from(getEluSamples().keys())) {
        forgetEluSample(wcId);
      }
    });

    it("recordEluSample stores ratio derived from blocking and window", () => {
      recordEluSample(42, { blockingDurationMs: 1500, sampleWindowMs: 3000 });
      const stored = getEluSamples().get(42);
      expect(stored?.blockingDurationMs).toBe(1500);
      expect(stored?.sampleWindowMs).toBe(3000);
      expect(stored?.ratio).toBeCloseTo(0.5, 5);
      expect(typeof stored?.timestamp).toBe("number");
    });

    it("ignores samples with non-positive sampleWindowMs", () => {
      recordEluSample(42, { blockingDurationMs: 1500, sampleWindowMs: 0 });
      expect(getEluSamples().has(42)).toBe(false);
    });

    it("clamps ratio to [0, 1]", () => {
      recordEluSample(1, { blockingDurationMs: -100, sampleWindowMs: 1000 });
      expect(getEluSamples().get(1)?.ratio).toBe(0);

      recordEluSample(2, { blockingDurationMs: 5000, sampleWindowMs: 1000 });
      expect(getEluSamples().get(2)?.ratio).toBe(1);
    });

    it("emits debug log with rounded ratio for every sample", () => {
      recordEluSample(7, { blockingDurationMs: 250, sampleWindowMs: 1000 });
      expect(logDebug).toHaveBeenCalledWith(
        "renderer-elu-sample",
        expect.objectContaining({ webContentsId: 7, ratio: 0.25 })
      );
    });

    it("does NOT log sustained-high warning while below threshold", () => {
      for (let i = 0; i < RENDERER_ELU_HIGH_SAMPLE_COUNT * 2; i++) {
        recordEluSample(42, { blockingDurationMs: 100, sampleWindowMs: 1000 });
      }
      expect(logWarn).not.toHaveBeenCalledWith("renderer-elu-sustained-high", expect.anything());
    });

    it("logs sustained-high warning exactly once when streak hits threshold", () => {
      const blocking = Math.ceil(RENDERER_ELU_HIGH_RATIO * 1000) + 1;
      for (let i = 0; i < RENDERER_ELU_HIGH_SAMPLE_COUNT; i++) {
        recordEluSample(42, { blockingDurationMs: blocking, sampleWindowMs: 1000 });
      }
      const highCalls = vi
        .mocked(logWarn)
        .mock.calls.filter((c) => c[0] === "renderer-elu-sustained-high");
      expect(highCalls).toHaveLength(1);
      expect(highCalls[0]![1]).toMatchObject({
        webContentsId: 42,
        consecutiveSamples: RENDERER_ELU_HIGH_SAMPLE_COUNT,
      });

      // Subsequent saturated samples should not emit additional warnings.
      recordEluSample(42, { blockingDurationMs: blocking, sampleWindowMs: 1000 });
      const stillOne = vi
        .mocked(logWarn)
        .mock.calls.filter((c) => c[0] === "renderer-elu-sustained-high");
      expect(stillOne).toHaveLength(1);
    });

    it("a single below-threshold sample resets the streak", () => {
      const blocking = Math.ceil(RENDERER_ELU_HIGH_RATIO * 1000) + 1;
      for (let i = 0; i < RENDERER_ELU_HIGH_SAMPLE_COUNT - 1; i++) {
        recordEluSample(42, { blockingDurationMs: blocking, sampleWindowMs: 1000 });
      }
      // One quiet sample: streak resets.
      recordEluSample(42, { blockingDurationMs: 50, sampleWindowMs: 1000 });
      expect(getEluHighStreaks().has(42)).toBe(false);

      // Now we need a fresh full streak before the warning fires.
      for (let i = 0; i < RENDERER_ELU_HIGH_SAMPLE_COUNT - 1; i++) {
        recordEluSample(42, { blockingDurationMs: blocking, sampleWindowMs: 1000 });
      }
      const noHighYet = vi
        .mocked(logWarn)
        .mock.calls.filter((c) => c[0] === "renderer-elu-sustained-high");
      expect(noHighYet).toHaveLength(0);

      recordEluSample(42, { blockingDurationMs: blocking, sampleWindowMs: 1000 });
      const highNow = vi
        .mocked(logWarn)
        .mock.calls.filter((c) => c[0] === "renderer-elu-sustained-high");
      expect(highNow).toHaveLength(1);
    });

    it("streaks are tracked independently per webContentsId", () => {
      const blocking = Math.ceil(RENDERER_ELU_HIGH_RATIO * 1000) + 1;
      for (let i = 0; i < RENDERER_ELU_HIGH_SAMPLE_COUNT - 1; i++) {
        recordEluSample(1, { blockingDurationMs: blocking, sampleWindowMs: 1000 });
        recordEluSample(2, { blockingDurationMs: blocking, sampleWindowMs: 1000 });
      }
      // Reset only view 1.
      recordEluSample(1, { blockingDurationMs: 0, sampleWindowMs: 1000 });
      // Push view 2 over the edge.
      recordEluSample(2, { blockingDurationMs: blocking, sampleWindowMs: 1000 });

      const highCalls = vi
        .mocked(logWarn)
        .mock.calls.filter((c) => c[0] === "renderer-elu-sustained-high");
      expect(highCalls).toHaveLength(1);
      expect(highCalls[0]![1]).toMatchObject({ webContentsId: 2 });
    });

    it("forgetEluSample clears both the sample and the streak", () => {
      const blocking = Math.ceil(RENDERER_ELU_HIGH_RATIO * 1000) + 1;
      recordEluSample(42, { blockingDurationMs: blocking, sampleWindowMs: 1000 });
      expect(getEluSamples().has(42)).toBe(true);
      expect(getEluHighStreaks().has(42)).toBe(true);

      forgetEluSample(42);
      expect(getEluSamples().has(42)).toBe(false);
      expect(getEluHighStreaks().has(42)).toBe(false);
    });

    // Documents current behavior: a view that goes "active" → "cached" →
    // "active" without an intervening below-threshold sample retains its
    // streak. The fan-out filter skips cached views, so no samples arrive
    // during the cached phase. If the streak was at N-1 before caching and
    // the next active sample is high, the warning fires immediately. This is
    // bounded — view eviction always calls forgetEluSample — but the logged
    // `windowMs` may overstate the contiguous observation period. Acceptable
    // for telemetry-only signal; if upgraded to a proactive trigger, the
    // streak should become gap-aware.
    it("(known limitation) streak survives caching gaps", () => {
      const blocking = Math.ceil(RENDERER_ELU_HIGH_RATIO * 1000) + 1;
      // Build streak to N-1 while view is active.
      for (let i = 0; i < RENDERER_ELU_HIGH_SAMPLE_COUNT - 1; i++) {
        recordEluSample(42, { blockingDurationMs: blocking, sampleWindowMs: 1000 });
      }
      // No samples arrive while the view is cached (fan-out skips it).
      // Then the view is reactivated and the next sample is also high.
      recordEluSample(42, { blockingDurationMs: blocking, sampleWindowMs: 1000 });

      const highCalls = vi
        .mocked(logWarn)
        .mock.calls.filter((c) => c[0] === "renderer-elu-sustained-high");
      expect(highCalls).toHaveLength(1);
    });

    it("startAppMetricsMonitor invokes actions.sampleRendererElu once per poll", () => {
      const sampleRendererElu = vi.fn();
      const actions: MemoryPressureActions = {
        clearCaches: vi.fn().mockResolvedValue(undefined),
        destroyHiddenWebviews: vi.fn().mockResolvedValue(undefined),
        hibernateIdleProjects: vi.fn().mockResolvedValue(undefined),
        sampleRendererElu,
      };

      stop = startAppMetricsMonitor(actions);

      vi.advanceTimersByTime(30_000);
      expect(sampleRendererElu).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(30_000 * 2);
      expect(sampleRendererElu).toHaveBeenCalledTimes(3);
    });

    it("sampleRendererElu throwing does not break the poll loop", () => {
      const sampleRendererElu = vi.fn().mockImplementation(() => {
        throw new Error("renderer port closed");
      });
      const actions: MemoryPressureActions = {
        clearCaches: vi.fn().mockResolvedValue(undefined),
        destroyHiddenWebviews: vi.fn().mockResolvedValue(undefined),
        hibernateIdleProjects: vi.fn().mockResolvedValue(undefined),
        sampleRendererElu,
      };

      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 100)]);
      stop = startAppMetricsMonitor(actions);

      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);

      expect(sampleRendererElu).toHaveBeenCalledTimes(2);
      expect(logDebug).toHaveBeenCalledWith("process-memory-sample", expect.any(Object));
    });

    it("works without sampleRendererElu (optional, backwards compat)", () => {
      const actions: MemoryPressureActions = {
        clearCaches: vi.fn().mockResolvedValue(undefined),
        destroyHiddenWebviews: vi.fn().mockResolvedValue(undefined),
        hibernateIdleProjects: vi.fn().mockResolvedValue(undefined),
      };
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 100)]);
      stop = startAppMetricsMonitor(actions);
      expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    });
  });
});
