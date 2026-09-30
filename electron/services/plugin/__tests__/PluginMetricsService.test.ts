// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../utils/appMetricsSnapshot.js", () => ({
  getAppMetricsSnapshot: vi.fn(() => []),
}));

import {
  CHANGE_COALESCE_MS,
  DURATION_WINDOW,
  MAX_TRACKED_PLUGINS,
  MAX_VIEW_LOADS,
  MEMORY_SAMPLE_INTERVAL_MS,
  ON_DEMAND_SAMPLE_MIN_INTERVAL_MS,
  PluginMetricsService,
  classifyInvokeFailure,
  type PluginMetricsHost,
  type ProcessMemorySample,
} from "../PluginMetricsService.js";
import { PluginInvokeTimeoutError } from "../pluginInvokeDeadline.js";
import { PluginPayloadTooLargeError } from "../pluginPayloadLimits.js";
import { PLUGIN_PERF_BUDGETS } from "../../../../shared/config/pluginBudgets.js";
import type { PluginRendererMetricsReport } from "../../../../shared/types/pluginMetrics.js";

interface Fixture {
  service: PluginMetricsService;
  known: Set<string>;
  builtins: Set<string>;
  pids: Map<string, number>;
  memory: ProcessMemorySample[];
  sampleProcessMemory: ReturnType<typeof vi.fn>;
}

/** The live load's authority every fixture plugin reports under. */
const GENERATION = "pi-live";

function makeFixture(): Fixture {
  const known = new Set<string>(["acme.demo"]);
  const builtins = new Set<string>();
  const pids = new Map<string, number>();
  const memory: ProcessMemorySample[] = [];
  const host: PluginMetricsHost = {
    isKnownPlugin: (id) => known.has(id),
    isCurrentGeneration: (id, generation) => known.has(id) && generation === GENERATION,
    isolationOf: (id) => (builtins.has(id) ? "in-process" : "worker"),
    workerPids: () => pids.entries(),
  };
  const sampleProcessMemory = vi.fn(() => memory);
  const service = new PluginMetricsService({ host, sampleProcessMemory });
  return { service, known, builtins, pids, memory, sampleProcessMemory };
}

function report(overrides: Partial<PluginRendererMetricsReport> = {}): PluginRendererMetricsReport {
  return {
    pluginId: "acme.demo",
    viewLoads: [],
    commitDurationsMs: [],
    commitCount: 0,
    longFramesDropped: { count: 0, blockingMs: 0 },
    longFrames: [],
    ...overrides,
  };
}

let fx: Fixture;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  fx = makeFixture();
});

afterEach(() => {
  fx.service.dispose();
  vi.useRealTimers();
});

describe("PluginMetricsService", () => {
  it("ignores plugins the host has not loaded", () => {
    fx.service.recordInvoke("acme.unknown", 5, "ok");
    fx.service.recordActivation("acme.unknown", 5);
    expect(fx.service.recordRendererReport(report({ pluginId: "acme.unknown" }), GENERATION)).toBe(
      false
    );
    expect(fx.service.getSnapshot("acme.unknown")).toBeNull();
    expect(fx.service.getAll()).toEqual([]);
  });

  it("returns an empty snapshot for a loaded plugin with nothing recorded", () => {
    const snap = fx.service.getSnapshot("acme.demo");
    expect(snap).toMatchObject({
      pluginId: "acme.demo",
      isolation: "worker",
      activation: null,
      viewCommits: null,
      workerMemory: null,
      overBudget: [],
      invokes: { count: 0, errors: 0 },
    });
  });

  it("reports isolation from the host", () => {
    fx.known.add("daintree.github");
    fx.builtins.add("daintree.github");
    expect(fx.service.getSnapshot("daintree.github")?.isolation).toBe("in-process");
  });

  it("counts activations and keeps the last duration", () => {
    fx.service.recordActivation("acme.demo", 120);
    fx.service.recordActivation("acme.demo", 80);
    expect(fx.service.getSnapshot("acme.demo")?.activation).toEqual({
      lastMs: 80,
      count: 2,
      at: 1_000_000,
    });
  });

  it("computes invoke percentiles over a bounded window and counts failure kinds", () => {
    for (let i = 1; i <= 100; i++) fx.service.recordInvoke("acme.demo", i, "ok");
    fx.service.recordInvoke("acme.demo", 1, "error");
    fx.service.recordInvoke("acme.demo", 1, "timeout");
    fx.service.recordInvoke("acme.demo", 1, "oversized");
    const invokes = fx.service.getSnapshot("acme.demo")!.invokes;
    expect(invokes.count).toBe(103);
    expect(invokes.maxMs).toBe(100);
    expect(invokes.lastMs).toBe(1);
    expect(invokes.errors).toBe(3);
    expect(invokes.timeouts).toBe(1);
    expect(invokes.oversized).toBe(1);
    expect(invokes.p50Ms).toBeGreaterThanOrEqual(45);
    expect(invokes.p50Ms).toBeLessThanOrEqual(55);
    expect(invokes.p95Ms).toBeGreaterThanOrEqual(90);
  });

  it("rolls old samples out of the percentile window while keeping the true count and max", () => {
    fx.service.recordInvoke("acme.demo", 10_000, "ok");
    for (let i = 0; i < DURATION_WINDOW; i++) fx.service.recordInvoke("acme.demo", 2, "ok");
    const invokes = fx.service.getSnapshot("acme.demo")!.invokes;
    expect(invokes.count).toBe(DURATION_WINDOW + 1);
    expect(invokes.p95Ms).toBe(2);
    expect(invokes.maxMs).toBe(10_000);
  });

  it("measures push rate over a sliding window that decays to zero", () => {
    fx.service.recordPushes("acme.demo", 100, 1_000);
    vi.advanceTimersByTime(1_000);
    fx.service.recordPushes("acme.demo", 100, 1_000);
    let pushes = fx.service.getSnapshot("acme.demo")!.pushes;
    expect(pushes.messages).toBe(200);
    expect(pushes.bytes).toBe(2_000);
    // Two seconds of activity: divided by the span seen, not the full window.
    expect(pushes.perSecond).toBeCloseTo(200, 0);

    vi.advanceTimersByTime(5_000);
    pushes = fx.service.getSnapshot("acme.demo")!.pushes;
    expect(pushes.perSecond).toBeCloseTo(200 / 6, 1);

    vi.advanceTimersByTime(20_000);
    pushes = fx.service.getSnapshot("acme.demo")!.pushes;
    expect(pushes.perSecond).toBe(0);
    expect(pushes.bytesPerSecond).toBe(0);
    expect(pushes.messages).toBe(200);
  });

  it("measures a burst after a long idle period over its own span", () => {
    fx.service.recordPushes("acme.demo", 1, 1);
    vi.advanceTimersByTime(60_000);
    fx.service.recordPushes("acme.demo", 100, 100);
    expect(fx.service.getSnapshot("acme.demo")!.pushes.perSecond).toBeCloseTo(100, 0);
  });

  it("flags every budget the measurements sit above, and nothing else", () => {
    const b = PLUGIN_PERF_BUDGETS;
    fx.service.recordActivation("acme.demo", b.activationMs + 1);
    fx.service.recordInvoke("acme.demo", b.invokeP95Ms + 50, "ok");
    fx.service.recordRendererReport(
      report({
        viewLoads: [
          {
            kindId: "acme.demo.panel",
            activateMs: 200,
            importMs: 150,
            stylesMs: 20,
            loadMs: b.viewLoadMs + 1,
            firstPaintMs: 100,
            retry: false,
            at: 1,
          },
        ],
        commitDurationsMs: [b.viewCommitP95Ms + 10],
        commitCount: 1,
      }),
      GENERATION
    );
    const over = fx.service.getSnapshot("acme.demo")!.overBudget;
    expect(over).toEqual(["activationMs", "viewLoadMs", "viewCommitP95Ms", "invokeP95Ms"]);
  });

  it("keeps an invoke that overlapped a prompt out of the latency window", () => {
    fx.service.recordInvoke("acme.demo", 5, "ok", fx.service.markInvokeStart("acme.demo"));

    // A prompt opened and answered during the call.
    const mark = fx.service.markInvokeStart("acme.demo");
    fx.service.beginPromptWait("acme.demo")();
    fx.service.recordInvoke("acme.demo", 1_258, "ok", mark);

    // A call that started while one was already open.
    const end = fx.service.beginPromptWait("acme.demo");
    fx.service.recordInvoke("acme.demo", 900, "error", fx.service.markInvokeStart("acme.demo"));
    end();
    end();

    fx.service.recordInvoke("acme.demo", 7, "ok", fx.service.markInvokeStart("acme.demo"));

    const invokes = fx.service.getSnapshot("acme.demo")!.invokes;
    expect(invokes).toMatchObject({ count: 4, promptWaits: 2, errors: 1, maxMs: 7 });
    expect(fx.service.getSnapshot("acme.demo")!.overBudget).not.toContain("invokeP95Ms");
  });

  it("does not judge invoke latency when every call waited on a prompt", () => {
    const end = fx.service.beginPromptWait("acme.demo");
    fx.service.recordInvoke("acme.demo", 5_000, "ok", fx.service.markInvokeStart("acme.demo"));
    end();
    const snap = fx.service.getSnapshot("acme.demo")!;
    expect(snap.invokes).toMatchObject({ count: 1, promptWaits: 1, p95Ms: 0 });
    expect(snap.overBudget).toEqual([]);
  });

  it("reports the busiest second beside the sustained push rate, judging only the sustained", () => {
    fx.service.recordPushes("acme.demo", 20_000, 2_000);
    vi.advanceTimersByTime(9_000);
    fx.service.recordPushes("acme.demo", 10, 1);
    const pushes = fx.service.getSnapshot("acme.demo")!.pushes;
    expect(pushes.peakPerSecond).toBe(20_000);
    expect(pushes.peakBytesPerSecond).toBe(2_000);
    expect(pushes.perSecond).toBeLessThan(pushes.peakPerSecond);
    // The burst's bucket has left the window; the later one has not.
    vi.advanceTimersByTime(5_000);
    expect(fx.service.getSnapshot("acme.demo")!.pushes.peakPerSecond).toBe(10);
  });

  it("samples worker memory when a snapshot is read, without a subscriber, at most every couple of seconds", () => {
    fx.pids.set("acme.demo", 42);
    fx.memory.push({ pid: 42, rssBytes: 90 * 1024 * 1024 });
    expect(fx.service.getSnapshot("acme.demo")!.workerMemory).toEqual({
      rssBytes: 90 * 1024 * 1024,
      at: 1_000_000,
    });
    expect(fx.service.getAll()[0]!.workerMemory).not.toBeNull();
    expect(fx.sampleProcessMemory).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(ON_DEMAND_SAMPLE_MIN_INTERVAL_MS);
    fx.service.getAll();
    expect(fx.sampleProcessMemory).toHaveBeenCalledTimes(2);
  });

  it("does not flag budgets with no measurement", () => {
    expect(fx.service.getSnapshot("acme.demo")!.overBudget).toEqual([]);
    fx.service.recordActivation("acme.demo", 1);
    expect(fx.service.getSnapshot("acme.demo")!.overBudget).toEqual([]);
  });

  it("accumulates renderer reports: exact commit counts, bounded view loads, dropped long frames", () => {
    const load = {
      kindId: "k",
      activateMs: 1,
      importMs: 1,
      stylesMs: 1,
      loadMs: 1,
      firstPaintMs: 1,
      retry: false,
      at: 1,
    };
    fx.service.recordRendererReport(
      report({
        viewLoads: Array.from({ length: MAX_VIEW_LOADS + 5 }, (_, i) => ({ ...load, at: i })),
        commitDurationsMs: [4, 8],
        commitCount: 900,
        longFrames: [{ durationMs: 80, blockingMs: 30, source: "commit", at: 50 }],
        longFramesDropped: { count: 4, blockingMs: 100 },
      }),
      GENERATION
    );
    fx.service.recordRendererReport(
      report({
        longFrames: [{ durationMs: 60, blockingMs: 10, source: "script", at: 20 }],
      }),
      GENERATION
    );
    const snap = fx.service.getSnapshot("acme.demo")!;
    expect(snap.viewLoads).toHaveLength(MAX_VIEW_LOADS);
    expect(snap.viewLoads[MAX_VIEW_LOADS - 1]!.at).toBe(MAX_VIEW_LOADS + 4);
    expect(snap.viewCommits).toMatchObject({ count: 900, maxMs: 8, lastMs: 8 });
    expect(snap.longFrames).toEqual({ count: 6, totalBlockingMs: 140, lastAt: 50 });
  });

  it("keeps viewCommits null when no commit durations were reported", () => {
    fx.service.recordRendererReport(report({ commitCount: 0 }), GENERATION);
    expect(fx.service.getSnapshot("acme.demo")!.viewCommits).toBeNull();
  });

  it("evicts a plugin's metrics and starts fresh after a reload", () => {
    fx.service.recordInvoke("acme.demo", 5, "ok");
    fx.service.evict("acme.demo");
    expect(fx.service.getAll()).toEqual([]);
    vi.advanceTimersByTime(10);
    fx.service.recordInvoke("acme.demo", 7, "ok");
    const snap = fx.service.getSnapshot("acme.demo")!;
    expect(snap.invokes.count).toBe(1);
    expect(snap.since).toBe(1_000_010);
  });

  it("bounds the number of tracked plugins", () => {
    for (let i = 0; i < MAX_TRACKED_PLUGINS + 10; i++) {
      fx.known.add(`acme.p${i}`);
      fx.service.recordInvoke(`acme.p${i}`, 1, "ok");
    }
    const all = fx.service.getAll();
    expect(all).toHaveLength(MAX_TRACKED_PLUGINS);
    expect(all.some((s) => s.pluginId === "acme.p0")).toBe(false);
  });

  describe("onDidChange", () => {
    it("coalesces to at most one call per interval, carrying every changed id", () => {
      fx.known.add("acme.other");
      const listener = vi.fn();
      fx.service.onDidChange(listener);
      fx.service.recordInvoke("acme.demo", 1, "ok");
      fx.service.recordInvoke("acme.other", 1, "ok");
      vi.advanceTimersByTime(0);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0]![0].sort()).toEqual(["acme.demo", "acme.other"]);

      fx.service.recordInvoke("acme.demo", 1, "ok");
      fx.service.recordInvoke("acme.demo", 1, "ok");
      vi.advanceTimersByTime(CHANGE_COALESCE_MS - 1);
      expect(listener).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("schedules nothing while no one listens", () => {
      fx.service.recordInvoke("acme.demo", 1, "ok");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps announcing a plugin until its push rate has decayed", () => {
      const listener = vi.fn();
      fx.service.onDidChange(listener);
      fx.service.recordPushes("acme.demo", 10, 10);
      vi.advanceTimersByTime(30_000);
      const calls = listener.mock.calls.length;
      expect(calls).toBeGreaterThan(2);
      expect(fx.service.getSnapshot("acme.demo")!.pushes.perSecond).toBe(0);
      vi.advanceTimersByTime(10_000);
      expect(listener.mock.calls.length).toBe(calls);
    });

    it("announces an eviction", () => {
      const listener = vi.fn();
      fx.service.recordInvoke("acme.demo", 1, "ok");
      fx.service.onDidChange(listener);
      fx.service.evict("acme.demo");
      vi.advanceTimersByTime(0);
      expect(listener).toHaveBeenCalledWith(["acme.demo"]);
    });
  });

  describe("worker memory sampling", () => {
    it("samples only while held, and skips the process sweep when no worker runs", () => {
      const release = fx.service.acquireSampling();
      expect(fx.sampleProcessMemory).not.toHaveBeenCalled();

      fx.pids.set("acme.demo", 42);
      fx.memory.push({ pid: 42, rssBytes: 300 * 1024 * 1024 }, { pid: 7, rssBytes: 1 });
      vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL_MS);
      expect(fx.sampleProcessMemory).toHaveBeenCalledTimes(1);
      const snap = fx.service.getSnapshot("acme.demo")!;
      expect(snap.workerMemory).toEqual({ rssBytes: 300 * 1024 * 1024, at: 1_005_000 });
      expect(snap.overBudget).toContain("workerRssBytes");

      release();
      vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL_MS * 3);
      expect(fx.sampleProcessMemory).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("samples immediately on a lease and stops once it expires", () => {
      fx.pids.set("acme.demo", 42);
      fx.memory.push({ pid: 42, rssBytes: 1024 });
      fx.service.leaseSampling(6_000);
      expect(fx.sampleProcessMemory).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL_MS);
      expect(fx.sampleProcessMemory).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL_MS * 2);
      expect(fx.sampleProcessMemory).toHaveBeenCalledTimes(2);
    });

    it("clears memory for a worker that is no longer running", () => {
      fx.pids.set("acme.demo", 42);
      fx.memory.push({ pid: 42, rssBytes: 1024 });
      fx.service.leaseSampling();
      expect(fx.service.getSnapshot("acme.demo")!.workerMemory).not.toBeNull();
      fx.pids.clear();
      vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL_MS);
      expect(fx.service.getSnapshot("acme.demo")!.workerMemory).toBeNull();
    });

    it("survives a sampler that throws", () => {
      fx.pids.set("acme.demo", 42);
      fx.sampleProcessMemory.mockImplementation(() => {
        throw new Error("boom");
      });
      expect(() => fx.service.leaseSampling()).not.toThrow();
      expect(fx.service.getSnapshot("acme.demo")!.workerMemory).toBeNull();
    });
  });
});

describe("classifyInvokeFailure", () => {
  it("recognises timeouts and oversize payloads by code or message prefix", () => {
    expect(classifyInvokeFailure(new PluginInvokeTimeoutError("a.b", "ch", 10))).toBe("timeout");
    expect(classifyInvokeFailure(new Error("PLUGIN_INVOKE_TIMEOUT: relayed from worker"))).toBe(
      "timeout"
    );
    expect(classifyInvokeFailure(new PluginPayloadTooLargeError("a.b", "result", 10))).toBe(
      "oversized"
    );
    expect(classifyInvokeFailure(new Error("PLUGIN_PAYLOAD_TOO_LARGE: relayed"))).toBe("oversized");
    expect(classifyInvokeFailure(new Error("PLUGIN_PAYLOAD_UNCLONEABLE: nope"))).toBe("error");
    expect(classifyInvokeFailure("boom")).toBe("error");
    expect(classifyInvokeFailure(null)).toBe("error");
  });
});
