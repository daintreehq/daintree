import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ now: 0 }));

vi.mock("node:perf_hooks", () => ({
  performance: {
    now: () => state.now,
    timeOrigin: 1_000_000,
  },
}));

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
  },
}));

import { logWarn } from "../logger.js";
import {
  startEventLoopLagMonitor,
  rebaseRendererElapsedMs,
  APP_BOOT_T0,
  mainTimeOrigin,
} from "../performance.js";

function createPowerEvents() {
  const suspendListeners = new Set<() => void>();
  const resumeListeners = new Set<() => void>();
  return {
    events: {
      onSuspend: (callback: () => void) => {
        suspendListeners.add(callback);
        return () => suspendListeners.delete(callback);
      },
      onResume: (callback: () => void) => {
        resumeListeners.add(callback);
        return () => resumeListeners.delete(callback);
      },
    },
    suspend: () => suspendListeners.forEach((cb) => cb()),
    resume: () => resumeListeners.forEach((cb) => cb()),
    listenerCount: () => suspendListeners.size + resumeListeners.size,
  };
}

// Each tick sets the mocked clock to the given value, then fires the interval once.
function tickAt(now: number): void {
  state.now = now;
  vi.advanceTimersByTime(1000);
}

describe("startEventLoopLagMonitor", () => {
  let stopFn: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    state.now = 0;
    vi.mocked(logWarn).mockClear();
  });

  afterEach(() => {
    stopFn?.();
    stopFn = null;
    vi.useRealTimers();
  });

  it("returns a cleanup function", () => {
    stopFn = startEventLoopLagMonitor(1000, 100);
    expect(typeof stopFn).toBe("function");
  });

  it("does not warn when lag is below threshold", () => {
    stopFn = startEventLoopLagMonitor(1000, 100);

    tickAt(1000);
    tickAt(2000);

    expect(logWarn).not.toHaveBeenCalled();
  });

  it("suppresses warnings during first 5 seconds", () => {
    stopFn = startEventLoopLagMonitor(1000, 100);

    tickAt(1200);
    tickAt(2200);

    expect(logWarn).not.toHaveBeenCalled();
  });

  it("warns on the tick after the lagged one, with the original magnitude", () => {
    stopFn = startEventLoopLagMonitor(1000, 100);

    tickAt(6000);
    expect(logWarn).not.toHaveBeenCalled();

    tickAt(7000);
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith("Event loop lag detected", {
      lagMs: 5000,
      intervalMs: 1000,
    });
  });

  it("rate-limits warnings to one per 10 seconds", () => {
    stopFn = startEventLoopLagMonitor(1000, 100);

    // Lag observed at 6s, confirmed on the next tick → warns
    tickAt(6000);
    tickAt(7200);
    expect(logWarn).toHaveBeenCalledTimes(1);

    // The 200ms lag observed at 7.2s is confirmed here but rate-limited
    tickAt(17500);
    expect(logWarn).toHaveBeenCalledTimes(1);

    // Lag observed at 17.5s (>10s after the last warning) → warns
    tickAt(18500);
    expect(logWarn).toHaveBeenCalledTimes(2);
  });

  it("cleanup clears the interval", () => {
    stopFn = startEventLoopLagMonitor(1000, 100);
    stopFn();
    stopFn = null;

    tickAt(6200);
    tickAt(7200);

    expect(logWarn).not.toHaveBeenCalled();
  });

  it("drops a lagged sample that is still pending when stopped", () => {
    stopFn = startEventLoopLagMonitor(1000, 100);

    tickAt(6000);
    stopFn();
    stopFn = null;
    tickAt(7000);

    expect(logWarn).not.toHaveBeenCalled();
  });

  it("still reports a genuine long stall while awake", () => {
    const power = createPowerEvents();
    stopFn = startEventLoopLagMonitor(1000, 100, power.events);

    tickAt(10_000);
    tickAt(11_000);
    vi.mocked(logWarn).mockClear();

    tickAt(1_011_000);
    tickAt(1_012_000);

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith("Event loop lag detected", {
      lagMs: 999_000,
      intervalMs: 1000,
    });
  });

  describe("across system sleep", () => {
    function settle(): ReturnType<typeof createPowerEvents> {
      const power = createPowerEvents();
      stopFn = startEventLoopLagMonitor(1000, 100, power.events);
      // Get past startup suppression with an awake baseline.
      for (let t = 1000; t <= 20_000; t += 1000) tickAt(t);
      vi.mocked(logWarn).mockClear();
      return power;
    }

    it("ignores the overdue tick when suspend and resume both precede it", () => {
      const power = settle();

      power.suspend();
      state.now = 24_109_403;
      power.resume();
      tickAt(24_109_403);
      tickAt(24_110_403);
      tickAt(24_111_403);

      expect(logWarn).not.toHaveBeenCalled();
    });

    it("drops the overdue tick when it runs before resume", () => {
      const power = settle();

      power.suspend();
      tickAt(1_020_000);
      power.resume();
      tickAt(1_021_000);
      tickAt(1_022_000);

      expect(logWarn).not.toHaveBeenCalled();
    });

    it("drops the overdue tick when suspend was never delivered and resume arrives after it", () => {
      const power = settle();

      tickAt(1_020_000);
      power.resume();
      tickAt(1_021_000);
      tickAt(1_022_000);

      expect(logWarn).not.toHaveBeenCalled();
    });

    it("ignores the overdue tick when suspend was never delivered and resume arrives first", () => {
      const power = settle();

      state.now = 1_020_000;
      power.resume();
      tickAt(1_020_000);
      tickAt(1_021_000);
      tickAt(1_022_000);

      expect(logWarn).not.toHaveBeenCalled();
    });

    it("drops a sample that was pending when suspend arrived", () => {
      const power = settle();

      tickAt(1_020_000);
      power.suspend();
      tickAt(1_021_000);
      power.resume();
      tickAt(1_022_000);
      tickAt(1_023_000);

      expect(logWarn).not.toHaveBeenCalled();
    });

    it("reports a stall on the very first tick after resume", () => {
      const power = settle();

      power.suspend();
      state.now = 1_020_000;
      power.resume();
      tickAt(1_026_000);
      expect(logWarn).not.toHaveBeenCalled();

      tickAt(1_027_000);
      expect(logWarn).toHaveBeenCalledTimes(1);
      expect(logWarn).toHaveBeenCalledWith("Event loop lag detected", {
        lagMs: 5000,
        intervalMs: 1000,
      });
    });

    it("ignores ticks that run while suspended (dark wake)", () => {
      const power = settle();

      power.suspend();
      tickAt(920_000);
      tickAt(1_820_000);
      tickAt(1_821_000);

      expect(logWarn).not.toHaveBeenCalled();
    });

    it("resumes reporting genuine stalls after a wake", () => {
      const power = settle();

      power.suspend();
      state.now = 1_020_000;
      power.resume();
      tickAt(1_020_000);
      tickAt(1_021_000);
      expect(logWarn).not.toHaveBeenCalled();

      tickAt(1_027_000);
      tickAt(1_028_000);
      expect(logWarn).toHaveBeenCalledTimes(1);
      expect(logWarn).toHaveBeenCalledWith("Event loop lag detected", {
        lagMs: 5000,
        intervalMs: 1000,
      });
    });

    it("unsubscribes from power events on stop, and stop is idempotent", () => {
      const power = createPowerEvents();
      stopFn = startEventLoopLagMonitor(1000, 100, power.events);
      expect(power.listenerCount()).toBe(2);

      stopFn();
      stopFn();
      stopFn = null;

      expect(power.listenerCount()).toBe(0);
    });
  });
});

describe("startEventLoopLagMonitor capture marks", () => {
  const originalCapture = process.env.DAINTREE_PERF_CAPTURE;
  const originalFile = process.env.DAINTREE_PERF_METRICS_FILE;
  let stopFn: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    state.now = 0;
    process.env.DAINTREE_PERF_CAPTURE = "1";
    process.env.DAINTREE_PERF_METRICS_FILE = "perf-metrics.jsonl";
    vi.resetModules();
  });

  afterEach(() => {
    stopFn?.();
    stopFn = null;
    vi.useRealTimers();
    if (originalCapture === undefined) delete process.env.DAINTREE_PERF_CAPTURE;
    else process.env.DAINTREE_PERF_CAPTURE = originalCapture;
    if (originalFile === undefined) delete process.env.DAINTREE_PERF_METRICS_FILE;
    else process.env.DAINTREE_PERF_METRICS_FILE = originalFile;
    vi.resetModules();
  });

  async function lagMarks(): Promise<Array<{ meta: { lagMs: number } }>> {
    const fs = (await import("node:fs")).default;
    return vi
      .mocked(fs.appendFileSync)
      .mock.calls.map(([, line]) => JSON.parse(String(line)))
      .filter((payload) => payload.mark === "event_loop_lag");
  }

  it("records an awake stall but not a sleep-spanning tick", async () => {
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.appendFileSync).mockClear();
    const perf = await import("../performance.js");
    const power = createPowerEvents();
    stopFn = perf.startEventLoopLagMonitor(1000, 100, power.events);

    tickAt(1000);
    tickAt(1_001_000);
    power.resume();
    tickAt(1_002_000);
    tickAt(1_003_000);
    expect(await lagMarks()).toHaveLength(0);

    tickAt(1_010_000);
    tickAt(1_011_000);
    const marks = await lagMarks();
    expect(marks).toHaveLength(1);
    expect(marks[0].meta.lagMs).toBe(6000);
  });

  it("records consecutive lagged ticks once each, in order", async () => {
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.appendFileSync).mockClear();
    const perf = await import("../performance.js");
    stopFn = perf.startEventLoopLagMonitor(1000, 100);

    tickAt(1500);
    tickAt(2800);
    tickAt(3800);

    expect((await lagMarks()).map((m) => m.meta.lagMs)).toEqual([500, 300]);
  });
});

describe("rebaseRendererElapsedMs", () => {
  it("computes correct rebased elapsed time", () => {
    // APP_BOOT_T0 = 0 (performance.now() at module load, mocked to 0)
    // mainTimeOrigin = 1_000_000 (mocked)
    // rendererTimeOrigin = 1_000_100 (renderer started 100ms after main)
    // rendererT0 = 5 (performance.now() in renderer at module load)
    // elapsedMs = 200 (time since rendererT0)
    // Expected: (1_000_100 + 5 + 200) - (1_000_000 + 0) = 305
    const result = rebaseRendererElapsedMs(1_000_100, 5, 200);
    expect(result).toBe(305);
  });

  it("produces values greater than renderer elapsed when renderer started after main", () => {
    // Renderer started 500ms after main boot
    const result = rebaseRendererElapsedMs(1_000_500, 10, 50);
    // (1_000_500 + 10 + 50) - (1_000_000 + 0) = 560
    expect(result).toBe(560);
  });

  it("exports APP_BOOT_T0 and mainTimeOrigin", () => {
    expect(typeof APP_BOOT_T0).toBe("number");
    expect(typeof mainTimeOrigin).toBe("number");
  });
});
