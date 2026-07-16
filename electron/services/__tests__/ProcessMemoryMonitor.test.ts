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

vi.mock("../diskPressureState.js", () => ({
  getWritesSuppressed: vi.fn().mockReturnValue(false),
  setWritesSuppressed: vi.fn(),
  resetWritesSuppressedForTesting: vi.fn(),
}));

vi.mock("../SystemSleepService.js", () => {
  const mockSleepService = {
    onSuspend: vi.fn().mockReturnValue(vi.fn()),
    onWake: vi.fn().mockReturnValue(vi.fn()),
  };
  return { getSystemSleepService: vi.fn(() => mockSleepService) };
});

import os from "os";
import { mkdirSync } from "node:fs";
import { app } from "electron";
import v8 from "node:v8";
import { logDebug, logInfo, logWarn } from "../../utils/logger.js";
import { getWritesSuppressed } from "../diskPressureState.js";
import { getSystemSleepService } from "../SystemSleepService.js";
import {
  startAppMetricsMonitor,
  WARMUP_INTERVALS,
  PRESSURE_COUNT_TIER2,
  MITIGATION_COOLDOWN_MS,
  RECLAIM_SETTLE_MS,
  MIN_RECLAIMED_MB,
  recordBlinkSample,
  forgetBlinkSample,
  getBlinkSamples,
  recordEluSample,
  forgetEluSample,
  getEluSamples,
  getEluHighStreaks,
  RENDERER_ELU_HIGH_RATIO,
  RENDERER_ELU_HIGH_SAMPLE_COUNT,
  hasSustainedRendererSaturation,
  getTrendSnapshot,
  type MemoryPressureActions,
} from "../ProcessMemoryMonitor.js";

const EIGHT_GB = 8 * 1024 * 1024 * 1024;

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
    vi.setSystemTime(1_830_001);
    vi.clearAllMocks();
    // Pin total RAM so the RAM-scaled per-process thresholds resolve to the
    // legacy absolute values (Browser 300 / Tab 768 / Utility 500) and the
    // aggregate threshold resolves to 2048 MB — deterministic across CI hosts.
    vi.spyOn(os, "totalmem").mockReturnValue(EIGHT_GB);
    mockGetAppMetrics.mockReturnValue([]);
  });

  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  // --- Memory metric is workingSetSize unconditionally (privateBytes is
  // Windows-only and reports 0 on macOS/Linux, so the previous
  // `privateBytes ?? workingSetSize` fallback silently never fired there). ---

  it("uses workingSetSize even when privateBytes is present and larger", () => {
    // workingSetSize = 100 MB (below 300 MB Browser threshold on 8 GB)
    // privateBytes  = 350 MB (would exceed if it were used)
    mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 100 * 1024, 100, 350 * 1024)]);

    stop = startAppMetricsMonitor();
    vi.advanceTimersByTime(30_000);

    expect(logDebug).toHaveBeenCalledWith("process-memory-sample", {
      pid: 100,
      type: "Browser",
      mb: 100,
    });
    expect(logWarn).not.toHaveBeenCalledWith(
      "process-memory-threshold-exceeded",
      expect.anything()
    );
  });

  it("uses workingSetSize when privateBytes is not available", () => {
    // No privateBytes supplied — should use workingSetSize of 600 MB (> 500 MB Utility threshold)
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
    expect(trendCalls).toHaveLength(1);
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

  describe("RAM-scaled per-process thresholds (issue #8633)", () => {
    it("scales Browser threshold up on a 64 GB machine — 350 MB no longer warns", () => {
      // 64 GB * (300/8192) = 2400 MB Browser threshold; 350 MB is well below.
      vi.spyOn(os, "totalmem").mockReturnValue(64 * 1024 * 1024 * 1024);

      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor();
      vi.advanceTimersByTime(30_000);

      expect(logWarn).not.toHaveBeenCalledWith(
        "process-memory-threshold-exceeded",
        expect.anything()
      );
    });

    it("64 GB machine still warns when Browser exceeds the scaled 2400 MB threshold", () => {
      vi.spyOn(os, "totalmem").mockReturnValue(64 * 1024 * 1024 * 1024);

      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 2401 * 1024, 100)]);
      stop = startAppMetricsMonitor();
      vi.advanceTimersByTime(30_000);

      expect(logWarn).toHaveBeenCalledWith("process-memory-threshold-exceeded", {
        pid: 100,
        type: "Browser",
        mb: 2401,
        thresholdMb: 2400,
      });
    });

    it("scales Tab threshold down on a 4 GB machine — 400 MB now warns", () => {
      // 4 GB * (768/8192) = 384 MB Tab threshold; 400 MB exceeds it.
      vi.spyOn(os, "totalmem").mockReturnValue(4 * 1024 * 1024 * 1024);

      mockGetAppMetrics.mockReturnValue([makeMetric("Tab", 400 * 1024, 200)]);
      stop = startAppMetricsMonitor();
      vi.advanceTimersByTime(30_000);

      expect(logWarn).toHaveBeenCalledWith("process-memory-threshold-exceeded", {
        pid: 200,
        type: "Tab",
        mb: 400,
        thresholdMb: 384,
      });
    });

    it("does NOT warn at exactly the threshold (strict >)", () => {
      // 8 GB → Browser threshold is exactly 300 MB; 300 MB sample should not warn.
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 300 * 1024, 100)]);
      stop = startAppMetricsMonitor();
      vi.advanceTimersByTime(30_000);

      expect(logWarn).not.toHaveBeenCalledWith(
        "process-memory-threshold-exceeded",
        expect.anything()
      );
    });
  });

  describe("aggregate working-set pressure (issue #8633)", () => {
    let mockActions: MemoryPressureActions;

    beforeEach(() => {
      mockActions = {
        destroyHiddenWebviews: vi.fn().mockResolvedValue(0),
        hibernateIdleProjects: vi.fn().mockResolvedValue(undefined),
        evictCachedProjectViews: vi.fn().mockResolvedValue(0),
      };
    });

    async function advancePolls(n: number): Promise<void> {
      for (let i = 0; i < n; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      await vi.advanceTimersByTimeAsync(RECLAIM_SETTLE_MS);
    }

    it("triggers mitigation when sum exceeds 25% of RAM even though no process alone exceeds its threshold", async () => {
      // 8 GB * 0.25 = 2048 MB aggregate threshold.
      // 5 × 500 MB Tab processes = 2500 MB total (> 2048).
      // Per-process Tab threshold is 768 MB — none individually exceeds.
      mockGetAppMetrics.mockReturnValue([
        makeMetric("Tab", 500 * 1024, 201),
        makeMetric("Tab", 500 * 1024, 202),
        makeMetric("Tab", 500 * 1024, 203),
        makeMetric("Tab", 500 * 1024, 204),
        makeMetric("Tab", 500 * 1024, 205),
      ]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + 1);

      expect(mockActions.destroyHiddenWebviews).toHaveBeenCalledWith(1);
      // No per-process threshold warnings should have fired (each Tab is below 768 MB).
      expect(logWarn).not.toHaveBeenCalledWith(
        "process-memory-threshold-exceeded",
        expect.anything()
      );
    });

    it("does NOT trigger mitigation when sum stays below 25% of RAM", async () => {
      // 4 × 400 MB Tab processes = 1600 MB total (< 2048 MB aggregate threshold).
      mockGetAppMetrics.mockReturnValue([
        makeMetric("Tab", 400 * 1024, 201),
        makeMetric("Tab", 400 * 1024, 202),
        makeMetric("Tab", 400 * 1024, 203),
        makeMetric("Tab", 400 * 1024, 204),
      ]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2 + 1);

      expect(mockActions.destroyHiddenWebviews).not.toHaveBeenCalled();
      expect(mockActions.hibernateIdleProjects).not.toHaveBeenCalled();
    });

    it("ignores unmonitored process types in the aggregate sum", async () => {
      // Massive GPU/Zygote totals should NOT count toward aggregate (they are
      // not in MONITORED_TYPES). Only the small Browser process contributes.
      mockGetAppMetrics.mockReturnValue([
        makeMetric("GPU", 3000 * 1024, 901),
        makeMetric("Zygote", 3000 * 1024, 902),
        makeMetric("Browser", 100 * 1024, 100),
      ]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2 + 1);

      expect(mockActions.destroyHiddenWebviews).not.toHaveBeenCalled();
    });

    it("escalates aggregate-only pressure to tier 2 after sustained polls", async () => {
      // Same 5-Tab × 500 MB setup — aggregate 2500 MB stays above the 2048 MB
      // ceiling, no single Tab trips its 768 MB per-type threshold.
      mockGetAppMetrics.mockReturnValue([
        makeMetric("Tab", 500 * 1024, 201),
        makeMetric("Tab", 500 * 1024, 202),
        makeMetric("Tab", 500 * 1024, 203),
        makeMetric("Tab", 500 * 1024, 204),
        makeMetric("Tab", 500 * 1024, 205),
      ]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);
      // Tier 2 escalates inside the tier-1 mitigation cycle, gated on the
      // post-mitigation re-sample that runs once the RECLAIM_SETTLE_MS settle
      // window elapses. The block-level advancePolls only flushes microtasks,
      // so drive the settle delay explicitly so the re-sample and tier-2
      // decision run before the assertion.
      await vi.advanceTimersByTimeAsync(RECLAIM_SETTLE_MS);

      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(1);
    });

    it("resets consecutive count when aggregate drops below threshold", async () => {
      // Above-threshold setup.
      const overThreshold = [
        makeMetric("Tab", 500 * 1024, 201),
        makeMetric("Tab", 500 * 1024, 202),
        makeMetric("Tab", 500 * 1024, 203),
        makeMetric("Tab", 500 * 1024, 204),
        makeMetric("Tab", 500 * 1024, 205),
      ];
      mockGetAppMetrics.mockReturnValue(overThreshold);
      stop = startAppMetricsMonitor(mockActions);

      // Past warmup + (PRESSURE_COUNT_TIER2 - 1) polls of aggregate pressure.
      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2 - 1);
      expect(mockActions.hibernateIdleProjects).not.toHaveBeenCalled();

      // Drop aggregate below threshold for one poll.
      mockGetAppMetrics.mockReturnValue([makeMetric("Tab", 100 * 1024, 201)]);
      await advancePolls(1);

      // Resume aggregate pressure — count restarted, should still need PRESSURE_COUNT_TIER2.
      mockGetAppMetrics.mockReturnValue(overThreshold);
      await advancePolls(PRESSURE_COUNT_TIER2 - 1);
      expect(mockActions.hibernateIdleProjects).not.toHaveBeenCalled();
    });
  });

  describe("system-wide low-memory signal (issue #8633)", () => {
    let mockActions: MemoryPressureActions;
    let originalGetSystemMemoryInfo: unknown;

    beforeEach(() => {
      mockActions = {
        destroyHiddenWebviews: vi.fn().mockResolvedValue(0),
        hibernateIdleProjects: vi.fn().mockResolvedValue(undefined),
        evictCachedProjectViews: vi.fn().mockResolvedValue(0),
      };
      originalGetSystemMemoryInfo = (process as { getSystemMemoryInfo?: unknown })
        .getSystemMemoryInfo;
    });

    afterEach(() => {
      if (originalGetSystemMemoryInfo === undefined) {
        delete (process as { getSystemMemoryInfo?: unknown }).getSystemMemoryInfo;
      } else {
        (process as { getSystemMemoryInfo?: unknown }).getSystemMemoryInfo =
          originalGetSystemMemoryInfo;
      }
    });

    async function advancePolls(n: number): Promise<void> {
      for (let i = 0; i < n; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
    }

    function stubSystemMemoryInfo(freeKb: number, purgeableKb = 0): void {
      (
        process as {
          getSystemMemoryInfo?: () => { free: number; purgeable?: number; total: number };
        }
      ).getSystemMemoryInfo = () => ({
        free: freeKb,
        purgeable: purgeableKb,
        total: EIGHT_GB / 1024,
      });
    }

    it("triggers mitigation when free + purgeable drops below 10% of total RAM", async () => {
      // 8 GB * 0.10 = 819.2 MB threshold. Report 500 MB free + 100 MB purgeable
      // = 600 MB available, below threshold. No process exceeds its threshold.
      stubSystemMemoryInfo(500 * 1024, 100 * 1024);
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 100 * 1024, 100)]);

      stop = startAppMetricsMonitor(mockActions);
      await advancePolls(WARMUP_INTERVALS + 1);

      expect(mockActions.destroyHiddenWebviews).toHaveBeenCalledWith(1);
    });

    it("does NOT trigger mitigation when free + purgeable stays above threshold", async () => {
      // 1500 MB free, well above the 819 MB threshold.
      stubSystemMemoryInfo(1500 * 1024);
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 100 * 1024, 100)]);

      stop = startAppMetricsMonitor(mockActions);
      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2 + 1);

      expect(mockActions.destroyHiddenWebviews).not.toHaveBeenCalled();
    });

    it("counts purgeable toward available on macOS — free alone below threshold but purgeable rescues", async () => {
      // 500 MB free + 500 MB purgeable = 1000 MB available, > 819 MB threshold.
      // Without the purgeable summation this would falsely trigger on macOS.
      stubSystemMemoryInfo(500 * 1024, 500 * 1024);
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 100 * 1024, 100)]);

      stop = startAppMetricsMonitor(mockActions);
      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2 + 1);

      expect(mockActions.destroyHiddenWebviews).not.toHaveBeenCalled();
    });

    it("skips the signal when getSystemMemoryInfo is unavailable", async () => {
      // Remove the API entirely to simulate test/sandbox environments.
      delete (process as { getSystemMemoryInfo?: unknown }).getSystemMemoryInfo;
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 100 * 1024, 100)]);

      stop = startAppMetricsMonitor(mockActions);
      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2 + 1);

      // No throw, no mitigation triggered.
      expect(mockActions.destroyHiddenWebviews).not.toHaveBeenCalled();
    });

    it("does not treat 1116 MB available as critical on a 64 GB machine", async () => {
      vi.spyOn(os, "totalmem").mockReturnValue(64 * 1024 * 1024 * 1024);
      stubSystemMemoryInfo(1116 * 1024);
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 100 * 1024, 100)]);

      stop = startAppMetricsMonitor(mockActions);
      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2 + 1);

      expect(mockActions.destroyHiddenWebviews).not.toHaveBeenCalled();
      expect(mockActions.hibernateIdleProjects).not.toHaveBeenCalled();
    });

    it("escalates sustained system-only pressure and evicts cached views", async () => {
      stubSystemMemoryInfo(500 * 1024);
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 100 * 1024, 100)]);
      vi.mocked(mockActions.destroyHiddenWebviews).mockImplementation(async (tier) => {
        if (tier === 1) {
          mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 10 * 1024, 100)]);
        }
      });

      stop = startAppMetricsMonitor(mockActions);
      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);
      await vi.advanceTimersByTimeAsync(RECLAIM_SETTLE_MS);

      expect(mockActions.destroyHiddenWebviews).toHaveBeenCalledWith(1);
      expect(mockActions.destroyHiddenWebviews).toHaveBeenCalledWith(2);
      expect(mockActions.evictCachedProjectViews).toHaveBeenCalledTimes(1);
      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(1);
    });
  });

  describe("memory pressure mitigation", () => {
    let mockActions: MemoryPressureActions;

    beforeEach(() => {
      mockActions = {
        destroyHiddenWebviews: vi.fn().mockResolvedValue(0),
        hibernateIdleProjects: vi.fn().mockResolvedValue(undefined),
      };
    });

    // Helper that mocks getAppMetrics to return `beforeMb` until tier 1
    // is called, then returns `afterMb`. Lets each test express the
    // closed-loop reclamation delta directly.
    function arrangeClosedLoopMetrics(opts: {
      beforeMb: number;
      afterMb: number;
      pid?: number;
    }): void {
      const { beforeMb, afterMb, pid = 100 } = opts;
      let postMitigation = false;
      mockGetAppMetrics.mockImplementation(() => {
        const mb = postMitigation ? afterMb : beforeMb;
        return [makeMetric("Browser", mb * 1024, pid, mb * 1024)];
      });
      mockActions.destroyHiddenWebviews = vi.fn().mockImplementation(async (tier) => {
        if (tier === 1) postMitigation = true;
        return 0;
      });
    }

    // Advances `n` polls then drives the async mitigation IIFE through its
    // {@link RECLAIM_SETTLE_MS} settle delay so the re-sample and tier-2
    // decision run before assertions.
    async function advancePolls(n: number): Promise<void> {
      for (let i = 0; i < n; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      await vi.advanceTimersByTimeAsync(RECLAIM_SETTLE_MS);
    }

    it("works without actions parameter (backward compat)", () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor();
      vi.advanceTimersByTime(30_000 * 10);
      // No crash, no mitigation called
    });

    it("does not reclaim hidden views during warmup period", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS);

      expect(mockActions.destroyHiddenWebviews).not.toHaveBeenCalled();
    });

    it("reclaims hidden views on first pressure poll after warmup", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      // Advance past warmup
      await advancePolls(WARMUP_INTERVALS + 1);

      expect(mockActions.destroyHiddenWebviews).toHaveBeenCalledWith(1);
    });

    it("does not escalate to tier 2 when tier 1 reclaims above the minimum", async () => {
      // Tier 1 frees 100 MB (well above MIN_RECLAIMED_MB), and the post-
      // settle sample drops below the Browser pressure threshold — both
      // halves of the AND gate should suppress escalation.
      arrangeClosedLoopMetrics({ beforeMb: 350, afterMb: 250 });
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + 1);

      expect(mockActions.destroyHiddenWebviews).toHaveBeenCalledWith(1);
      expect(mockActions.hibernateIdleProjects).not.toHaveBeenCalled();
      expect(mockActions.destroyHiddenWebviews).not.toHaveBeenCalledWith(2);
    });

    it("escalates to tier 2 when tier 1 reclaims insufficient memory and pressure remains", async () => {
      // Tier 1 freed only 10 MB (< MIN_RECLAIMED_MB) and pressure persists.
      arrangeClosedLoopMetrics({ beforeMb: 350, afterMb: 340 });
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);

      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(1);
      expect(mockActions.destroyHiddenWebviews).toHaveBeenCalledWith(2);
    });

    it("does NOT escalate to tier 2 when post-settle re-sample shows pressure cleared", async () => {
      // Tier 1 freed only 5 MB (< MIN_RECLAIMED_MB) but pressure dropped
      // below threshold after the settle window — pressureRemains is false,
      // so the AND gate suppresses escalation even though delta is small.
      arrangeClosedLoopMetrics({ beforeMb: 305, afterMb: 295 });
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + 1);

      expect(mockActions.hibernateIdleProjects).not.toHaveBeenCalled();
      expect(mockActions.destroyHiddenWebviews).not.toHaveBeenCalledWith(2);
    });

    it("logs reclaim delta alongside before/after totals", async () => {
      arrangeClosedLoopMetrics({ beforeMb: 350, afterMb: 250 });
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + 1);

      expect(logInfo).toHaveBeenCalledWith(
        "memory-pressure-tier1-reclaim",
        expect.objectContaining({
          beforeMb: 350,
          afterMb: 250,
          deltaMb: 100,
          pressureRemains: false,
        })
      );
    });

    it("re-samples app.getAppMetrics() only after the settle delay elapses", async () => {
      arrangeClosedLoopMetrics({ beforeMb: 350, afterMb: 250 });
      stop = startAppMetricsMonitor(mockActions);

      // Advance to the first post-warmup poll and let the IIFE start, but
      // stop short of the settle delay completing.
      for (let i = 0; i < WARMUP_INTERVALS + 1; i++) {
        vi.advanceTimersByTime(30_000);
      }
      // Let the IIFE run up to the settle await.
      await vi.advanceTimersByTimeAsync(0);

      // The reclaim log fires only after the settle delay; nothing yet.
      expect(logInfo).not.toHaveBeenCalledWith("memory-pressure-tier1-reclaim", expect.any(Object));

      // Advance through the settle delay; now the IIFE completes.
      await vi.advanceTimersByTimeAsync(RECLAIM_SETTLE_MS);

      expect(logInfo).toHaveBeenCalledWith("memory-pressure-tier1-reclaim", expect.any(Object));
    });

    it("respects tier 2 cooldown — no re-trigger within cooldown period", async () => {
      // Tier 1 reclaims very little, so tier 2 fires every cycle absent the
      // cooldown.
      arrangeClosedLoopMetrics({ beforeMb: 350, afterMb: 345 });
      stop = startAppMetricsMonitor(mockActions);

      // Trigger tier 2 after sustained post-warmup pressure.
      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);
      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(1);

      // Continue pressure — should not trigger again within cooldown.
      await advancePolls(3);
      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(1);
    });

    it("allows tier 2 re-trigger after cooldown expires", async () => {
      arrangeClosedLoopMetrics({ beforeMb: 350, afterMb: 345 });
      stop = startAppMetricsMonitor(mockActions);

      // Trigger tier 2.
      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);
      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(1);

      // Advance past cooldown (pressure remains, delta remains insufficient).
      const cooldownPolls = Math.ceil(MITIGATION_COOLDOWN_MS / 30_000);
      await advancePolls(cooldownPolls + 1);

      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(2);
    });

    it("logs tier 1 and tier 2 mitigation events", async () => {
      arrangeClosedLoopMetrics({ beforeMb: 350, afterMb: 345 });
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

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);

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
      // Default mockActions leaves the metrics unchanged; reclaim
      // delta stays at 0 so tier 2 should still fire here.
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(actionsWithTrim);

      await advancePolls(WARMUP_INTERVALS + 1);

      expect(trimPtyHostState).toHaveBeenCalled();
      expect(actionsWithTrim.destroyHiddenWebviews).toHaveBeenCalledWith(1);
    });

    it("calls destroyHiddenWebviews(1) on tier 1 mitigation", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + 1);

      expect(mockActions.destroyHiddenWebviews).toHaveBeenCalledWith(1);
    });

    it("does not repeat tier 1 on every poll during one pressure episode", async () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + 6);

      const tier1Calls = vi
        .mocked(mockActions.destroyHiddenWebviews)
        .mock.calls.filter(([tier]) => tier === 1);
      expect(tier1Calls).toHaveLength(1);
    });

    it("calls destroyHiddenWebviews(2) on tier 2 mitigation", async () => {
      // Zero reclamation + sustained pressure → tier 2 fires.
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

      expect(mockActions.destroyHiddenWebviews).not.toHaveBeenCalled();
      expect(mockActions.hibernateIdleProjects).not.toHaveBeenCalled();
    });

    it("escalation gate honors MIN_RECLAIMED_MB at the boundary", async () => {
      // Reclaim exactly equals MIN_RECLAIMED_MB → the gate `deltaMb <
      // MIN_RECLAIMED_MB` is false, so no escalation even with pressure
      // persisting.
      arrangeClosedLoopMetrics({ beforeMb: 400, afterMb: 400 - MIN_RECLAIMED_MB });
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);

      expect(mockActions.hibernateIdleProjects).not.toHaveBeenCalled();
    });

    it("escalates to tier 2 when the post-settle re-sample throws", async () => {
      // Regression: the post-settle catch block must produce deltaMb=0,
      // not deltaMb=beforeMb, so the AND gate falls through to escalation.
      // Without `afterMb = beforeMb` inside the catch, the large derived
      // delta would suppress tier 2 even with pressureRemains=true.
      let throwNextSample = false;
      mockGetAppMetrics.mockImplementation(() => {
        if (throwNextSample) {
          throwNextSample = false;
          throw new Error("getAppMetrics unavailable");
        }
        return [makeMetric("Browser", 350 * 1024, 100)];
      });
      mockActions.destroyHiddenWebviews = vi.fn().mockImplementation(async (tier) => {
        if (tier === 1) throwNextSample = true;
      });
      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);

      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(1);
      expect(logInfo).toHaveBeenCalledWith(
        "memory-pressure-tier1-reclaim",
        expect.objectContaining({
          pressureRemains: true,
          resampleFailed: true,
          deltaMb: 0,
        })
      );
    });

    it("consumes tier-2 cooldown even when hibernateIdleProjects throws", async () => {
      // Regression: lastTier2At must be stamped before the tier-2 awaits.
      // Otherwise a partial failure (destroyHiddenWebviews(2) succeeds,
      // hibernateIdleProjects throws) leaves the cooldown unconsumed and the
      // next pressure poll re-fires destroyHiddenWebviews(2).
      arrangeClosedLoopMetrics({ beforeMb: 350, afterMb: 345 });
      mockActions.hibernateIdleProjects = vi
        .fn()
        .mockRejectedValueOnce(new Error("hibernate failed"))
        .mockResolvedValue(undefined);

      stop = startAppMetricsMonitor(mockActions);

      await advancePolls(WARMUP_INTERVALS + PRESSURE_COUNT_TIER2);
      // First cycle: tier-2 attempted, destroyHiddenWebviews(2) called,
      // hibernate throws. Cooldown should still be consumed.
      expect(mockActions.destroyHiddenWebviews).toHaveBeenCalledWith(2);
      const destroyCallsAfterFirst = vi
        .mocked(mockActions.destroyHiddenWebviews)
        .mock.calls.filter((c) => c[0] === 2).length;
      expect(destroyCallsAfterFirst).toBe(1);

      // Second cycle within cooldown: no new tier-2 fire.
      await advancePolls(3);
      const destroyCallsAfterSecond = vi
        .mocked(mockActions.destroyHiddenWebviews)
        .mock.calls.filter((c) => c[0] === 2).length;
      expect(destroyCallsAfterSecond).toBe(1);
    });
  });

  describe("tier-2 reclaim measurement (issue #11211)", () => {
    let mockActions: MemoryPressureActions;

    beforeEach(() => {
      mockActions = {
        destroyHiddenWebviews: vi.fn().mockResolvedValue(0),
        hibernateIdleProjects: vi.fn().mockResolvedValue(undefined),
        evictCachedProjectViews: vi.fn().mockResolvedValue(0),
      };
    });

    // Aggregate-only pressure: 5 × 500 MB Tabs = 2500 MB, over the 2048 MB
    // (25% of 8 GB) ceiling, with no single Tab over its 768 MB threshold.
    function metricsForMb(totalMb: number): Electron.ProcessMetric[] {
      return [makeMetric("Tab", totalMb * 1024, 201)];
    }

    const underPressure = [
      makeMetric("Tab", 500 * 1024, 201),
      makeMetric("Tab", 500 * 1024, 202),
      makeMetric("Tab", 500 * 1024, 203),
      makeMetric("Tab", 500 * 1024, 204),
      makeMetric("Tab", 500 * 1024, 205),
    ];

    // Tier 1 fires on the first pressure poll; its 5-min cooldown then blocks
    // a re-run, so when tier 2 escalates two polls later it is the only tier
    // acting in that cycle and its settle is the only one left to drive. The
    // aligned poll fires at the very end of each 30s advance, so the loop
    // leaves the mitigation parked on that settle.
    async function advanceToTier2(): Promise<void> {
      for (let i = 0; i < WARMUP_INTERVALS + PRESSURE_COUNT_TIER2; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      await vi.advanceTimersByTimeAsync(RECLAIM_SETTLE_MS);
    }

    it("measures its own reclaim across a settle window that starts after its actions", async () => {
      mockGetAppMetrics.mockReturnValue(underPressure);
      // The drop lands midway through the settle window, not when the lever
      // returns. Only a sample taken after the window can see it: an
      // implementation that measured straight after the levers and merely
      // delayed the log would report 0. The tier-1 sample, taken before the
      // levers, cannot see it either.
      mockActions.hibernateIdleProjects = vi.fn().mockImplementation(async () => {
        setTimeout(() => {
          mockGetAppMetrics.mockReturnValue(metricsForMb(100));
        }, RECLAIM_SETTLE_MS / 2);
      });

      stop = startAppMetricsMonitor(mockActions);
      await advanceToTier2();

      expect(logInfo).toHaveBeenCalledWith(
        "memory-pressure-tier2-reclaim",
        expect.objectContaining({
          beforeMb: 2500,
          afterMb: 100,
          deltaMb: 2400,
          pressureRemains: false,
        })
      );
    });

    it("does not emit its reclaim log before the settle window elapses", async () => {
      mockGetAppMetrics.mockReturnValue(underPressure);
      stop = startAppMetricsMonitor(mockActions);

      for (let i = 0; i < WARMUP_INTERVALS + PRESSURE_COUNT_TIER2; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }

      // Tier 2's levers have all run, but the reclaim is only measured once
      // the settle window elapses — reporting before it would sample memory
      // the levers have not had a chance to release.
      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(1);
      expect(logInfo).not.toHaveBeenCalledWith("memory-pressure-tier2-reclaim", expect.any(Object));

      await vi.advanceTimersByTimeAsync(RECLAIM_SETTLE_MS);
      expect(logInfo).toHaveBeenCalledWith("memory-pressure-tier2-reclaim", expect.any(Object));
    });

    it("reports what each tier destroyed so a zero delta is attributable", async () => {
      // Nothing is freed, so both tiers report deltaMb 0 — the counts are what
      // separate "nothing was eligible" from "levers ran, the metric could not
      // observe it yet". Each tier returns a distinct count so a tier that
      // reported its sibling's number would not pass.
      mockGetAppMetrics.mockReturnValue(underPressure);
      mockActions.destroyHiddenWebviews = vi
        .fn()
        .mockImplementation(async (tier: 1 | 2) => (tier === 1 ? 2 : 4));
      mockActions.evictCachedProjectViews = vi.fn().mockResolvedValue(3);

      stop = startAppMetricsMonitor(mockActions);
      await advanceToTier2();

      expect(logInfo).toHaveBeenCalledWith(
        "memory-pressure-tier1-reclaim",
        expect.objectContaining({ deltaMb: 0, portalTabsDestroyed: 2 })
      );
      expect(logInfo).toHaveBeenCalledWith(
        "memory-pressure-tier2-reclaim",
        expect.objectContaining({ deltaMb: 0, portalTabsDestroyed: 4, viewsEvicted: 3 })
      );
    });

    it("logs tier-2 escalation inputs instead of a no-action delta", async () => {
      // The mitigation line used to carry `deltaMb` from a before/after pair
      // sampled back-to-back with nothing acting between them — ~0 by
      // construction, and read as "tier 2 reclaimed nothing".
      mockGetAppMetrics.mockReturnValue(underPressure);
      stop = startAppMetricsMonitor(mockActions);
      await advanceToTier2();

      const mitigation = vi
        .mocked(logInfo)
        .mock.calls.find(([event]) => event === "memory-pressure-tier2-mitigation");

      expect(mitigation).toBeDefined();
      expect(mitigation?.[1]).not.toHaveProperty("deltaMb");
      expect(mitigation?.[1]).toMatchObject({
        tier1ReclaimMb: 0,
        systemPressureRemains: false,
      });
    });

    it("still measures reclaim when a tier-2 lever throws", async () => {
      // A failing lever must not skip the levers after it or blind the
      // measurement — the reclaim log is the point of the tier.
      mockGetAppMetrics.mockReturnValue(underPressure);
      mockActions.destroyHiddenWebviews = vi.fn().mockImplementation(async (tier: 1 | 2) => {
        if (tier === 2) throw new Error("portal manager gone");
        return 0;
      });
      mockActions.hibernateIdleProjects = vi.fn().mockImplementation(async () => {
        mockGetAppMetrics.mockReturnValue(metricsForMb(100));
      });

      stop = startAppMetricsMonitor(mockActions);
      await advanceToTier2();

      expect(mockActions.evictCachedProjectViews).toHaveBeenCalledTimes(1);
      expect(mockActions.hibernateIdleProjects).toHaveBeenCalledTimes(1);
      expect(logInfo).toHaveBeenCalledWith(
        "memory-pressure-tier2-reclaim",
        expect.objectContaining({ deltaMb: 2400, portalTabsDestroyed: 0 })
      );
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
        destroyHiddenWebviews: vi.fn().mockResolvedValue(0),
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
        destroyHiddenWebviews: vi.fn().mockResolvedValue(0),
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
        destroyHiddenWebviews: vi.fn().mockResolvedValue(0),
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

    it("hasSustainedRendererSaturation reports false below the streak threshold and true at it", () => {
      const blocking = Math.ceil(RENDERER_ELU_HIGH_RATIO * 1000) + 1;
      for (let i = 0; i < RENDERER_ELU_HIGH_SAMPLE_COUNT - 1; i++) {
        recordEluSample(42, { blockingDurationMs: blocking, sampleWindowMs: 1000 });
      }
      expect(hasSustainedRendererSaturation()).toBe(false);

      recordEluSample(42, { blockingDurationMs: blocking, sampleWindowMs: 1000 });
      expect(hasSustainedRendererSaturation()).toBe(true);
    });

    it("hasSustainedRendererSaturation clears when the saturated view is forgotten", () => {
      const blocking = Math.ceil(RENDERER_ELU_HIGH_RATIO * 1000) + 1;
      for (let i = 0; i < RENDERER_ELU_HIGH_SAMPLE_COUNT; i++) {
        recordEluSample(42, { blockingDurationMs: blocking, sampleWindowMs: 1000 });
      }
      expect(hasSustainedRendererSaturation()).toBe(true);

      forgetEluSample(42);
      expect(hasSustainedRendererSaturation()).toBe(false);
    });

    it("hasSustainedRendererSaturation treats a stale streak as no pressure", () => {
      const blocking = Math.ceil(RENDERER_ELU_HIGH_RATIO * 1000) + 1;
      for (let i = 0; i < RENDERER_ELU_HIGH_SAMPLE_COUNT; i++) {
        recordEluSample(42, { blockingDurationMs: blocking, sampleWindowMs: 1000 });
      }
      const sample = getEluSamples().get(42)!;

      expect(hasSustainedRendererSaturation(sample.timestamp)).toBe(true);
      // Two poll periods after the last sample the streak is stale (the view
      // was evicted mid-streak or sampling paused) and must not stay latched.
      expect(hasSustainedRendererSaturation(sample.timestamp + 10 * 60_000)).toBe(false);
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
        destroyHiddenWebviews: vi.fn().mockResolvedValue(0),
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
        destroyHiddenWebviews: vi.fn().mockResolvedValue(0),
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

    describe("threshold edge-triggered latching (issue #7114)", () => {
      it("warns only once across consecutive over-threshold polls for the same pid", () => {
        mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);

        stop = startAppMetricsMonitor();
        vi.advanceTimersByTime(30_000); // first poll — warns
        vi.advanceTimersByTime(30_000); // second poll — still over, no new warning

        const thresholdCalls = vi
          .mocked(logWarn)
          .mock.calls.filter((c) => c[0] === "process-memory-threshold-exceeded");
        expect(thresholdCalls).toHaveLength(1);
      });

      it("re-warns when pid drops below threshold then exceeds again (re-entry)", () => {
        mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
        stop = startAppMetricsMonitor();
        vi.advanceTimersByTime(30_000); // first crossing — warns

        mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 100)]);
        vi.advanceTimersByTime(30_000); // below threshold — latch cleared

        mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
        vi.advanceTimersByTime(30_000); // re-crossing — warns again

        const thresholdCalls = vi
          .mocked(logWarn)
          .mock.calls.filter((c) => c[0] === "process-memory-threshold-exceeded");
        expect(thresholdCalls).toHaveLength(2);
      });

      it("each pid latches independently", () => {
        mockGetAppMetrics.mockReturnValue([
          makeMetric("Browser", 350 * 1024, 100),
          makeMetric("Tab", 800 * 1024, 200),
        ]);
        stop = startAppMetricsMonitor();

        vi.advanceTimersByTime(30_000); // both cross — each warns once
        vi.advanceTimersByTime(30_000); // both still over — no new warnings

        const thresholdCalls = vi
          .mocked(logWarn)
          .mock.calls.filter((c) => c[0] === "process-memory-threshold-exceeded");
        expect(thresholdCalls).toHaveLength(2);
        expect(thresholdCalls[0]![1]).toMatchObject({ pid: 100 });
        expect(thresholdCalls[1]![1]).toMatchObject({ pid: 200 });
      });

      it("clears threshold latch on suspend so post-wake re-entry warns", () => {
        mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
        stop = startAppMetricsMonitor();
        vi.advanceTimersByTime(30_000);

        // Simulate suspend → wake
        const mockSleep = getSystemSleepService();
        const onSuspend = vi.mocked(mockSleep.onSuspend).mock.calls[0]![0]!;
        const onWake = vi.mocked(mockSleep.onWake).mock.calls[0]![0]!;
        onSuspend();
        onWake(0);

        vi.advanceTimersByTime(30_000); // re-entry after wake — warns again

        const thresholdCalls = vi
          .mocked(logWarn)
          .mock.calls.filter((c) => c[0] === "process-memory-threshold-exceeded");
        expect(thresholdCalls).toHaveLength(2);
      });

      it("prunes threshold latch when pid disappears from metrics", () => {
        mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 100)]);
        stop = startAppMetricsMonitor();
        vi.advanceTimersByTime(30_000);

        // Pid 100 disappears, replaced by 200
        mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 350 * 1024, 200)]);
        vi.advanceTimersByTime(30_000);

        const thresholdCalls = vi
          .mocked(logWarn)
          .mock.calls.filter((c) => c[0] === "process-memory-threshold-exceeded");
        expect(thresholdCalls).toHaveLength(2);
        expect(thresholdCalls[0]![1]).toMatchObject({ pid: 100 });
        expect(thresholdCalls[1]![1]).toMatchObject({ pid: 200 });
      });
    });

    describe("trend per-pid latch (issue #7114)", () => {
      it("warns only once per pid during sustained growth", () => {
        const baseMb = 100;
        const growthPerTickMb = 0.1; // ~6 MB/hr
        let tick = 0;

        mockGetAppMetrics.mockImplementation(() => {
          const mb = baseMb + tick * growthPerTickMb;
          tick++;
          return [makeMetric("Tab", mb * 1024, 500, mb * 1024)];
        });

        stop = startAppMetricsMonitor();
        vi.advanceTimersByTime(120 * 30_000); // well past initial warning

        const trendCalls = vi
          .mocked(logWarn)
          .mock.calls.filter((c) => c[0] === "process-memory-trend-warning");
        expect(trendCalls).toHaveLength(1);
      });

      it("clears trend latch when growth reverses to negative (growthMbPerHour <= 0)", () => {
        // Phase 1: strong growth triggers warning for pid 500
        let tick = 0;
        mockGetAppMetrics.mockImplementation(() => {
          const mb = 100 + tick * 0.15;
          tick++;
          return [makeMetric("Tab", mb * 1024, 500, mb * 1024)];
        });

        stop = startAppMetricsMonitor();
        vi.advanceTimersByTime(62 * 30_000);

        const afterFirst = vi
          .mocked(logWarn)
          .mock.calls.filter((c) => c[0] === "process-memory-trend-warning");
        expect(afterFirst).toHaveLength(1);

        // Phase 2: steep decline for pid 500 to clear its trend latch
        // Then introduce a NEW pid 501 with growth. If the pid 500 latch
        // was properly cleared by the decline, it won't interfere with
        // pid 501; and pid 501 should get its own independent warning.
        const dropStartTick = tick;
        mockGetAppMetrics.mockImplementation(() => {
          const mb = 100 + dropStartTick * 0.15 - (tick - dropStartTick) * 2;
          tick++;
          return [makeMetric("Tab", mb * 1024, 500, mb * 1024)];
        });
        vi.advanceTimersByTime(80 * 30_000);

        // Pid 500 disappears, pid 501 starts fresh with growth
        tick = 0;
        mockGetAppMetrics.mockImplementation(() => {
          const mb = 100 + tick * 0.15;
          tick++;
          return [makeMetric("Tab", mb * 1024, 501, mb * 1024)];
        });
        vi.advanceTimersByTime(62 * 30_000);

        // Pid 501 should get its own warning — pid 500 was pruned when it
        // disappeared from metrics, proving latch entries are cleaned up
        // alongside trend state and don't leak across pid lifecycle.
        const trendCalls = vi
          .mocked(logWarn)
          .mock.calls.filter((c) => c[0] === "process-memory-trend-warning");
        expect(trendCalls).toHaveLength(2);
        expect(trendCalls[0]![1]).toMatchObject({ pid: 500 });
        expect(trendCalls[1]![1]).toMatchObject({ pid: 501 });
      });

      it("does NOT clear trend latch when growth drops only slightly below threshold", () => {
        // Start with strong growth to trigger latch
        let tick = 0;
        let mb = 100;

        mockGetAppMetrics.mockImplementation(() => {
          // First 62 polls: strong growth (triggers latch)
          // Then: growth drops to 2 MB/hr (still positive, just below threshold)
          if (tick < 62) {
            mb = 100 + tick * 0.1;
          } else {
            mb = 100 + 62 * 0.1 + (tick - 62) * 0.05; // still positive ~3 MB/hr
          }
          tick++;
          return [makeMetric("Tab", Math.round(mb * 1024), 500, Math.round(mb * 1024))];
        });

        stop = startAppMetricsMonitor();
        vi.advanceTimersByTime(100 * 30_000);

        const trendCalls = vi
          .mocked(logWarn)
          .mock.calls.filter((c) => c[0] === "process-memory-trend-warning");
        // Only one warning — the latch stays set because growth never went <= 0.
        // Positive-but-below-threshold growth does not clear the latch (hysteresis).
        expect(trendCalls).toHaveLength(1);
      });

      it("clears trend latch on suspend", () => {
        let tick = 0;

        mockGetAppMetrics.mockImplementation(() => {
          const mb = 100 + tick * 0.1;
          tick++;
          return [makeMetric("Tab", mb * 1024, 500, mb * 1024)];
        });

        stop = startAppMetricsMonitor();
        vi.advanceTimersByTime(62 * 30_000); // triggers trend warning

        const afterFirst = vi
          .mocked(logWarn)
          .mock.calls.filter((c) => c[0] === "process-memory-trend-warning");
        expect(afterFirst).toHaveLength(1);

        // Suspend clears trend state and latches
        const mockSleep = getSystemSleepService();
        const onSuspend = vi.mocked(mockSleep.onSuspend).mock.calls[0]![0]!;
        const onWake = vi.mocked(mockSleep.onWake).mock.calls[0]![0]!;

        // Set up fresh growth metrics BEFORE wake so the immediate poll() sees them
        tick = 0;
        mockGetAppMetrics.mockImplementation(() => {
          const mb = 100 + tick * 0.1;
          tick++;
          return [makeMetric("Tab", mb * 1024, 500, mb * 1024)];
        });

        onSuspend();
        onWake(0); // immediate poll fires with fresh growth data

        vi.advanceTimersByTime(62 * 30_000);

        const trendCalls = vi
          .mocked(logWarn)
          .mock.calls.filter((c) => c[0] === "process-memory-trend-warning");
        expect(trendCalls).toHaveLength(2);
      });
    });

    describe("heap snapshot write gating (issue #7114)", () => {
      it("skips heap snapshot when writes are suppressed", () => {
        mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700 * 1024, 100)]);
        Object.defineProperty(app, "isPackaged", { value: false, writable: true });
        vi.mocked(getWritesSuppressed).mockReturnValue(true);

        stop = startAppMetricsMonitor();
        vi.advanceTimersByTime(30_000);

        expect(v8.writeHeapSnapshot).not.toHaveBeenCalled();
        expect(logDebug).toHaveBeenCalledWith("heap-snapshot-suppressed", {
          pid: 100,
          reason: "disk-pressure-write-gate",
        });
      });

      it("writes heap snapshot when writes are NOT suppressed", () => {
        mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700 * 1024, 100)]);
        Object.defineProperty(app, "isPackaged", { value: false, writable: true });
        vi.mocked(getWritesSuppressed).mockReturnValue(false);

        stop = startAppMetricsMonitor();
        vi.advanceTimersByTime(30_000);

        expect(v8.writeHeapSnapshot).toHaveBeenCalledTimes(1);
      });
      it("suppressed heap snapshot does not consume cooldown", () => {
        mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700 * 1024, 100)]);
        Object.defineProperty(app, "isPackaged", { value: false, writable: true });

        // First poll: writes suppressed
        vi.mocked(getWritesSuppressed).mockReturnValue(true);
        stop = startAppMetricsMonitor();
        vi.advanceTimersByTime(30_000);
        expect(v8.writeHeapSnapshot).not.toHaveBeenCalled();

        // Second poll (within cooldown): writes no longer suppressed
        vi.mocked(getWritesSuppressed).mockReturnValue(false);
        vi.advanceTimersByTime(30_000);

        // Should write snapshot because cooldown was NOT consumed by suppression
        expect(v8.writeHeapSnapshot).toHaveBeenCalledTimes(1);
      });

      it("suppressed heap snapshot skips mkdirSync and getPath", () => {
        mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 700 * 1024, 100)]);
        Object.defineProperty(app, "isPackaged", { value: false, writable: true });
        vi.mocked(getWritesSuppressed).mockReturnValue(true);

        stop = startAppMetricsMonitor();
        vi.advanceTimersByTime(30_000);

        expect(mkdirSync).not.toHaveBeenCalled();
        expect(app.getPath).not.toHaveBeenCalledWith("logs");
      });
    });

    describe("wake handler immediate poll (issue #7114)", () => {
      it("polls immediately on wake before re-arming timer", () => {
        mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 100)]);

        stop = startAppMetricsMonitor();
        const mockSleep = getSystemSleepService();
        const onSuspend = vi.mocked(mockSleep.onSuspend).mock.calls[0]![0]!;
        const onWake = vi.mocked(mockSleep.onWake).mock.calls[0]![0]!;

        // Initial poll via timer
        vi.advanceTimersByTime(30_000);
        expect(logDebug).toHaveBeenCalledTimes(1);

        // Suspend: timer is cleared
        onSuspend();

        // Wake: should poll immediately
        onWake(0);

        // Verify poll happened synchronously on wake (debug log count increased
        // without advancing the fake timer)
        expect(logDebug).toHaveBeenCalledTimes(2);

        // Then the next timer tick fires as expected
        vi.advanceTimersByTime(30_000);
        expect(logDebug).toHaveBeenCalledTimes(3);
      });
    });

    it("works without sampleRendererElu (optional, backwards compat)", () => {
      const actions: MemoryPressureActions = {
        destroyHiddenWebviews: vi.fn().mockResolvedValue(0),
        hibernateIdleProjects: vi.fn().mockResolvedValue(undefined),
      };
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 100)]);
      stop = startAppMetricsMonitor(actions);
      expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    });
  });

  describe("getTrendSnapshot (#10500)", () => {
    it("is empty immediately after start, before any poll", () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 4242)]);
      stop = startAppMetricsMonitor();
      expect(getTrendSnapshot()).toEqual([]);
    });

    it("captures per-pid working-set EMA after polling a monitored process", () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 4242)]);
      stop = startAppMetricsMonitor();
      vi.advanceTimersByTime(30_000);

      const browser = getTrendSnapshot().find((s) => s.pid === 4242);
      expect(browser).toBeDefined();
      // working-set 200 MB seeds the EMA at 200.
      expect(browser!.emaMb).toBe(200);
      expect(Array.isArray(browser!.emaHistoryMb)).toBe(true);
    });

    it("returns deep copies — mutating the snapshot can't corrupt internal state", () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 4242)]);
      stop = startAppMetricsMonitor();
      // Two ticks fill one EMA-history bucket (BUCKET_TICKS = 2).
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);

      const first = getTrendSnapshot();
      const historyLen = first[0]!.emaHistoryMb.length;
      expect(historyLen).toBeGreaterThan(0);
      first[0]!.emaHistoryMb.push(99_999);
      first[0]!.emaMb = -1;

      const second = getTrendSnapshot();
      expect(second[0]!.emaHistoryMb).toHaveLength(historyLen);
      expect(second[0]!.emaMb).toBe(200);
    });

    it("bounds emaHistoryMb (plateaus) and excludes non-monitored process types", () => {
      mockGetAppMetrics.mockReturnValue([
        makeMetric("Browser", 200 * 1024, 4242),
        makeMetric("GPU", 300 * 1024, 7777), // not in MONITORED_TYPES
      ]);
      stop = startAppMetricsMonitor();

      // Drive well past BUCKET_WINDOW buckets so the rolling buffer fills.
      for (let i = 0; i < 64; i++) vi.advanceTimersByTime(30_000);
      const lenA = getTrendSnapshot().find((s) => s.pid === 4242)!.emaHistoryMb.length;

      for (let i = 0; i < 10; i++) vi.advanceTimersByTime(30_000);
      const lenB = getTrendSnapshot().find((s) => s.pid === 4242)!.emaHistoryMb.length;

      // The buffer is bounded — it stops growing once full (no copy of the cap).
      expect(lenA).toBeGreaterThan(0);
      expect(lenB).toBe(lenA);
      // Non-monitored process types never enter the trend buffer.
      expect(getTrendSnapshot().some((s) => s.pid === 7777)).toBe(false);
    });

    it("clears stale pids when the monitor is restarted", () => {
      mockGetAppMetrics.mockReturnValue([makeMetric("Browser", 200 * 1024, 4242)]);
      stop = startAppMetricsMonitor();
      vi.advanceTimersByTime(30_000);
      expect(getTrendSnapshot().some((s) => s.pid === 4242)).toBe(true);
      stop();

      // A fresh monitor must not surface the previous lifetime's pid.
      stop = startAppMetricsMonitor();
      expect(getTrendSnapshot()).toEqual([]);
    });
  });
});
