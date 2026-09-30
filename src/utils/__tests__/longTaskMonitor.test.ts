// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let observerCallback: ((list: { getEntries: () => PerformanceEntry[] }) => void) | null = null;
let observerDisconnected = false;
let lastObserveOptions: PerformanceObserverInit | null = null;

class MockPerformanceObserver {
  constructor(callback: (list: { getEntries: () => PerformanceEntry[] }) => void) {
    observerCallback = callback;
    observerDisconnected = false;
  }
  observe(options: PerformanceObserverInit) {
    lastObserveOptions = options;
  }
  disconnect() {
    observerDisconnected = true;
  }
}

vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);

vi.mock("../logger", () => ({
  logWarn: vi.fn(),
}));

const mockIsRendererPerfCaptureEnabled = vi.fn(() => false);
const mockMarkRendererPerformance = vi.fn();

vi.mock("../performance", () => ({
  RENDERER_T0: 0,
  isRendererPerfCaptureEnabled: () => mockIsRendererPerfCaptureEnabled(),
  markRendererPerformance: (mark: string, meta?: Record<string, unknown>) =>
    mockMarkRendererPerformance(mark, meta),
}));

import { logWarn } from "../logger";
import { attributeLongFrameToPlugins, startLongTaskMonitor } from "../longTaskMonitor";
import { createPluginViewMetrics, pluginViewMetrics } from "@/services/plugin/pluginViewMetrics";

type ScriptFixture = {
  invoker?: string;
  invokerType?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  duration: number;
  forcedStyleAndLayoutDuration?: number;
};

function makeScript(s: ScriptFixture): PerformanceScriptTiming {
  return {
    name: "script",
    entryType: "script",
    startTime: 0,
    duration: s.duration,
    invoker: s.invoker ?? "",
    invokerType: s.invokerType ?? "user-callback",
    executionStart: 0,
    sourceURL: s.sourceURL ?? "",
    sourceFunctionName: s.sourceFunctionName ?? "",
    sourceCharPosition: -1,
    forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration ?? 0,
    pauseDuration: 0,
    windowAttribution: "self",
    toJSON: () => ({}),
  } as PerformanceScriptTiming;
}

type LoafFixture = {
  duration: number;
  blockingDuration?: number;
  scripts?: ScriptFixture[];
  startTime?: number;
};

function makeLoafEntry(opts: LoafFixture): PerformanceLongAnimationFrameTiming {
  return {
    name: "frame",
    entryType: "long-animation-frame",
    startTime: opts.startTime ?? 0,
    duration: opts.duration,
    blockingDuration: opts.blockingDuration ?? Math.max(0, opts.duration - 50),
    renderStart: 0,
    styleAndLayoutStart: 0,
    firstUIEventTimestamp: 0,
    presentationTime: 0,
    paintTime: 0,
    scripts: (opts.scripts ?? []).map(makeScript),
    toJSON: () => ({}),
  } as PerformanceLongAnimationFrameTiming;
}

function emitLoafEntries(entries: LoafFixture[]) {
  const built = entries.map((opts) => makeLoafEntry(opts) as unknown as PerformanceEntry);
  observerCallback?.({ getEntries: () => built });
}

function emitLoafEntry(opts: LoafFixture) {
  emitLoafEntries([opts]);
}

describe("startLongTaskMonitor", () => {
  let mockNow: number;

  beforeEach(() => {
    mockNow = 0;
    vi.spyOn(performance, "now").mockImplementation(() => mockNow);
    observerCallback = null;
    observerDisconnected = false;
    lastObserveOptions = null;
    vi.mocked(logWarn).mockClear();
    mockIsRendererPerfCaptureEnabled.mockClear().mockReturnValue(false);
    mockMarkRendererPerformance.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts without DAINTREE_PERF_CAPTURE and returns cleanup", () => {
    const stop = startLongTaskMonitor();
    expect(typeof stop).toBe("function");
    expect(observerCallback).not.toBeNull();
    stop();
    expect(observerDisconnected).toBe(true);
  });

  it("subscribes to long-animation-frame", () => {
    startLongTaskMonitor(120);
    expect(lastObserveOptions).toEqual({ type: "long-animation-frame" });
  });

  it("does not warn for frames below the default threshold", () => {
    mockNow = 6000;
    startLongTaskMonitor();
    emitLoafEntry({ duration: 99.9999 });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("warns for frames at the default threshold", () => {
    mockNow = 6000;
    startLongTaskMonitor();
    emitLoafEntry({ duration: 100 });
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "Renderer long animation frame detected",
      expect.objectContaining({ durationMs: 100 })
    );
  });

  it("does not warn for frames below the configured threshold", () => {
    mockNow = 6000;
    startLongTaskMonitor(120);
    emitLoafEntry({ duration: 119.9999 });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("warns for frames at the configured threshold", () => {
    mockNow = 6000;
    startLongTaskMonitor(120);
    emitLoafEntry({ duration: 120 });
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "Renderer long animation frame detected",
      expect.objectContaining({ durationMs: 120 })
    );
  });

  it("warns below the default threshold when a lower threshold is configured", () => {
    mockNow = 6000;
    startLongTaskMonitor(80);
    emitLoafEntry({ duration: 80 });
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "Renderer long animation frame detected",
      expect.objectContaining({ durationMs: 80 })
    );
  });

  it("suppresses warnings during first 5 seconds", () => {
    mockNow = 2000;
    startLongTaskMonitor(100);
    emitLoafEntry({ duration: 150 });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("does not consume the warning cooldown during startup suppression", () => {
    mockIsRendererPerfCaptureEnabled.mockReturnValue(true);
    mockNow = 2000;
    startLongTaskMonitor(100);

    emitLoafEntry({ duration: 150 });
    expect(logWarn).not.toHaveBeenCalled();

    mockNow = 6000;
    emitLoafEntry({ duration: 150 });
    expect(logWarn).toHaveBeenCalledTimes(1);

    expect(mockMarkRendererPerformance).toHaveBeenCalledTimes(2);
  });

  it("warns after suppression with first-script attribution", () => {
    mockNow = 6000;
    startLongTaskMonitor(100);
    emitLoafEntry({
      duration: 150,
      blockingDuration: 100,
      scripts: [
        {
          duration: 120,
          invoker: "BUTTON#go.onclick",
          invokerType: "event-listener",
          sourceURL: "https://app/bundle.js",
          sourceFunctionName: "handleGo",
        },
      ],
    });
    expect(logWarn).toHaveBeenCalledWith("Renderer long animation frame detected", {
      durationMs: 150,
      blockingDurationMs: 100,
      scriptCount: 1,
      invoker: "BUTTON#go.onclick",
      invokerType: "event-listener",
      sourceURL: "https://app/bundle.js",
      sourceFunctionName: "handleGo",
    });
  });

  it("warns with the highest-duration script's attribution, not the first in the array", () => {
    mockNow = 6000;
    startLongTaskMonitor(100);
    emitLoafEntry({
      duration: 200,
      blockingDuration: 150,
      scripts: [
        {
          duration: 40,
          invoker: "DIV.onclick",
          invokerType: "event-listener",
          sourceURL: "https://app/lo.js",
          sourceFunctionName: "small",
        },
        {
          duration: 130,
          invoker: "TIMEOUT",
          invokerType: "user-callback",
          sourceURL: "https://app/hi.js",
          sourceFunctionName: "big",
        },
      ],
    });
    expect(logWarn).toHaveBeenCalledWith(
      "Renderer long animation frame detected",
      expect.objectContaining({
        invoker: "TIMEOUT",
        invokerType: "user-callback",
        sourceURL: "https://app/hi.js",
        sourceFunctionName: "big",
      })
    );
  });

  it("warns without attribution fields when scripts is empty", () => {
    mockNow = 6000;
    startLongTaskMonitor(100);
    emitLoafEntry({ duration: 150, blockingDuration: 80, scripts: [] });
    expect(logWarn).toHaveBeenCalledWith("Renderer long animation frame detected", {
      durationMs: 150,
      blockingDurationMs: 80,
      scriptCount: 0,
    });
  });

  it("rate-limits warnings to one per 10 seconds", () => {
    mockNow = 6000;
    startLongTaskMonitor(100);

    emitLoafEntry({ duration: 150 });
    expect(logWarn).toHaveBeenCalledTimes(1);

    mockNow = 7000;
    emitLoafEntry({ duration: 150 });
    expect(logWarn).toHaveBeenCalledTimes(1);

    mockNow = 17000;
    emitLoafEntry({ duration: 150 });
    expect(logWarn).toHaveBeenCalledTimes(2);
  });

  it("does not consume the warning cooldown for below-threshold frames", () => {
    mockNow = 6000;
    startLongTaskMonitor();

    emitLoafEntry({ duration: 75 });
    expect(logWarn).toHaveBeenCalledTimes(0);

    emitLoafEntry({ duration: 100 });
    expect(logWarn).toHaveBeenCalledTimes(1);

    mockNow = 16000;
    emitLoafEntry({ duration: 75 });
    expect(logWarn).toHaveBeenCalledTimes(1);

    emitLoafEntry({ duration: 100 });
    expect(logWarn).toHaveBeenCalledTimes(2);
  });

  it("emits a renderer_long_animation_frame mark with top-3 scripts when capture is enabled", () => {
    mockIsRendererPerfCaptureEnabled.mockReturnValue(true);
    mockNow = 6000;
    startLongTaskMonitor(100);
    emitLoafEntry({
      duration: 200,
      blockingDuration: 150,
      scripts: [
        { duration: 30, sourceFunctionName: "tinyA" },
        { duration: 90, sourceFunctionName: "biggestB", invoker: "TIMEOUT" },
        { duration: 50, sourceFunctionName: "midC" },
        { duration: 10, sourceFunctionName: "smallestD" },
      ],
    });

    expect(mockMarkRendererPerformance).toHaveBeenCalledTimes(1);
    const call = mockMarkRendererPerformance.mock.calls[0]!;
    const [mark, meta] = call;
    expect(mark).toBe("renderer_long_animation_frame");
    expect(meta).toMatchObject({
      durationMs: 200,
      blockingDurationMs: 150,
      scriptCount: 4,
    });
    const topScripts = (meta as { topScripts: Array<Record<string, unknown>> }).topScripts;
    expect(topScripts).toHaveLength(3);
    expect(topScripts[0]).toMatchObject({ sourceFunctionName: "biggestB", durationMs: 90 });
    expect(topScripts[1]).toMatchObject({ sourceFunctionName: "midC", durationMs: 50 });
    expect(topScripts[2]).toMatchObject({ sourceFunctionName: "tinyA", durationMs: 30 });
  });

  it("emits a mark with empty topScripts when scripts is empty", () => {
    mockIsRendererPerfCaptureEnabled.mockReturnValue(true);
    mockNow = 6000;
    startLongTaskMonitor(100);
    emitLoafEntry({ duration: 150, blockingDuration: 100, scripts: [] });

    expect(mockMarkRendererPerformance).toHaveBeenCalledTimes(1);
    const call = mockMarkRendererPerformance.mock.calls[0]!;
    const meta = call[1];
    expect(meta).toMatchObject({ scriptCount: 0, topScripts: [] });
  });

  it("emits a mark for below-threshold frames when capture is enabled", () => {
    mockIsRendererPerfCaptureEnabled.mockReturnValue(true);
    mockNow = 6000;
    startLongTaskMonitor();
    emitLoafEntry({ duration: 75, scripts: [{ duration: 40, sourceFunctionName: "belowGate" }] });

    expect(logWarn).not.toHaveBeenCalled();
    expect(mockMarkRendererPerformance).toHaveBeenCalledTimes(1);
    expect(mockMarkRendererPerformance).toHaveBeenCalledWith(
      "renderer_long_animation_frame",
      expect.objectContaining({
        durationMs: 75,
        blockingDurationMs: 25,
        scriptCount: 1,
        topScripts: [expect.objectContaining({ sourceFunctionName: "belowGate", durationMs: 40 })],
      })
    );
  });

  it("warns once for a mixed batch delivered in one callback and captures every entry", () => {
    mockIsRendererPerfCaptureEnabled.mockReturnValue(true);
    mockNow = 6000;
    startLongTaskMonitor(100);
    emitLoafEntries([{ duration: 75 }, { duration: 100 }, { duration: 150 }]);

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "Renderer long animation frame detected",
      expect.objectContaining({ durationMs: 100 })
    );
    expect(mockMarkRendererPerformance).toHaveBeenCalledTimes(3);
    expect(mockMarkRendererPerformance.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ durationMs: 75 }),
      expect.objectContaining({ durationMs: 100 }),
      expect.objectContaining({ durationMs: 150 }),
    ]);
  });

  it("does not call markRendererPerformance when capture is disabled", () => {
    mockNow = 6000;
    startLongTaskMonitor(100);
    emitLoafEntry({ duration: 150 });
    expect(mockMarkRendererPerformance).not.toHaveBeenCalled();
  });
});

describe("attributeLongFrameToPlugins", () => {
  afterEach(() => {
    pluginViewMetrics.reset();
    vi.restoreAllMocks();
  });

  it("does nothing once no plugin view is mounted", () => {
    let now = 5_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const metrics = createPluginViewMetrics();
    metrics.registerViewOrigin("acme", "plugin://acme/v.js");
    metrics.retainView("acme")();
    now += 2_000;
    const recordLongFrame = vi.spyOn(metrics, "recordLongFrame");
    attributeLongFrameToPlugins(
      makeLoafEntry({
        duration: 200,
        scripts: [{ duration: 150, sourceURL: "plugin://acme/v.js" }],
      }),
      metrics
    );
    expect(recordLongFrame).not.toHaveBeenCalled();
  });

  it("attributes a frame to the plugin whose plugin:// script ran in it", () => {
    const metrics = createPluginViewMetrics();
    metrics.retainView("acme");
    metrics.registerViewOrigin("acme", "plugin://acme/__dtv-1/view.js");
    attributeLongFrameToPlugins(
      makeLoafEntry({
        duration: 120,
        blockingDuration: 70,
        startTime: 5000,
        scripts: [
          { duration: 40, sourceURL: "app://daintree/assets/index.js" },
          { duration: 60, sourceURL: "plugin://acme/__dtv-1/view.js" },
          { duration: 10, sourceURL: "plugin://acme/__dtv-1/chunk.js" },
        ],
      }),
      metrics
    );
    const [report] = metrics.drainReports();
    expect(report!.pluginId).toBe("acme");
    expect(report!.longFrames).toEqual([
      { durationMs: 120, blockingMs: 70, source: "script", at: expect.any(Number) },
    ]);
  });

  it("falls back to commit-time overlap for host-scheduled render work", () => {
    const metrics = createPluginViewMetrics();
    metrics.retainView("acme");
    metrics.recordCommit("acme", 30, 1040);
    metrics.recordCommit("beta", 5, 3005);
    metrics.drainReports();
    attributeLongFrameToPlugins(
      makeLoafEntry({
        duration: 100,
        blockingDuration: 50,
        startTime: 1000,
        scripts: [{ duration: 90, sourceURL: "app://daintree/assets/react-dom.js" }],
      }),
      metrics
    );
    const reports = metrics.drainReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.pluginId).toBe("acme");
    expect(reports[0]!.longFrames[0]!.source).toBe("commit");
  });

  it("records a plugin once per frame, preferring its script over a commit overlap", () => {
    const metrics = createPluginViewMetrics();
    metrics.retainView("acme");
    metrics.registerViewOrigin("acme", "plugin://acme/view.js");
    metrics.recordCommit("acme", 30, 1040);
    metrics.drainReports();
    attributeLongFrameToPlugins(
      makeLoafEntry({
        duration: 100,
        startTime: 1000,
        scripts: [{ duration: 90, sourceURL: "plugin://acme/view.js" }],
      }),
      metrics
    );
    const [report] = metrics.drainReports();
    expect(report!.longFrames.map((f) => f.source)).toEqual(["script"]);
  });

  it("runs from the observer without changing the warning behaviour", () => {
    vi.mocked(logWarn).mockClear();
    pluginViewMetrics.retainView("acme");
    pluginViewMetrics.recordCommit("acme", 30, 40);
    pluginViewMetrics.drainReports();
    startLongTaskMonitor(100);
    emitLoafEntry({ duration: 80, startTime: 0 });
    expect(logWarn).not.toHaveBeenCalled();
    expect(pluginViewMetrics.drainReports()[0]!.longFrames).toHaveLength(1);
  });
});

describe("production long-frame attribution", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("attributes a frame to the plugin whose style root received input during it", () => {
    const metrics = createPluginViewMetrics();
    metrics.retainView("acme");
    metrics.recordInput("acme", 1_050);
    metrics.recordInput("beta", 3_000);
    attributeLongFrameToPlugins(
      makeLoafEntry({ duration: 1_642, blockingDuration: 1_592, startTime: 1_000 }),
      metrics,
      () => []
    );
    const reports = metrics.drainReports();
    expect(reports.map((r) => r.pluginId)).toEqual(["acme"]);
    expect(reports[0]!.longFrames).toEqual([
      { durationMs: 1_642, blockingMs: 1_592, source: "input", at: expect.any(Number) },
    ]);
  });

  it("still attributes a frame delivered just after its input closed the last view", () => {
    let now = 5_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const metrics = createPluginViewMetrics();
    const release = metrics.retainView("acme");
    metrics.recordInput("acme", 4_900);
    release();
    now += 200;
    attributeLongFrameToPlugins(
      makeLoafEntry({ duration: 400, startTime: 4_800 }),
      metrics,
      () => []
    );
    expect(metrics.drainReports()[0]?.longFrames[0]?.source).toBe("input");
  });

  it("does not attribute input that landed outside the frame", () => {
    const metrics = createPluginViewMetrics();
    metrics.retainView("acme");
    metrics.recordInput("acme", 900);
    attributeLongFrameToPlugins(
      makeLoafEntry({ duration: 100, startTime: 1_000 }),
      metrics,
      () => []
    );
    expect(metrics.drainReports()).toEqual([]);
  });

  it("attributes a frame to plugins the preload delivered pushes to during it", () => {
    const metrics = createPluginViewMetrics();
    metrics.retainView("acme");
    const reader = vi.fn(() => ["acme"]);
    attributeLongFrameToPlugins(
      makeLoafEntry({ duration: 300, blockingDuration: 250, startTime: 2_000 }),
      metrics,
      reader
    );
    expect(reader).toHaveBeenCalledWith(2_000, 2_300);
    const [report] = metrics.drainReports();
    expect(report!.longFrames[0]!.source).toBe("push");
  });

  it("records a plugin once per frame, under the strongest observation", () => {
    const metrics = createPluginViewMetrics();
    metrics.retainView("acme");
    metrics.recordCommit("acme", 10, 1_010);
    metrics.recordInput("acme", 1_020);
    metrics.drainReports();
    attributeLongFrameToPlugins(makeLoafEntry({ duration: 100, startTime: 1_000 }), metrics, () => [
      "acme",
    ]);
    const [report] = metrics.drainReports();
    expect(report!.longFrames.map((frame) => frame.source)).toEqual(["commit"]);
  });

  it("notes UI events dispatched inside an owner-tagged root, including a portal", async () => {
    const { startPluginInputTracking } = await import("../longTaskMonitor");
    const metrics = createPluginViewMetrics();
    metrics.retainView("acme");
    const recordInput = vi.spyOn(metrics, "recordInput");
    const portal = document.createElement("div");
    portal.setAttribute("data-daintree-plugin-owner", "acme");
    const button = document.createElement("button");
    portal.appendChild(button);
    const outside = document.createElement("button");
    document.body.append(portal, outside);

    const stop = startPluginInputTracking(document, metrics);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    outside.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(recordInput).toHaveBeenCalledTimes(1);
    expect(recordInput).toHaveBeenCalledWith("acme", expect.any(Number));

    stop();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(recordInput).toHaveBeenCalledTimes(1);
  });

  it("ignores UI events while no plugin view is open", async () => {
    const { startPluginInputTracking } = await import("../longTaskMonitor");
    const metrics = createPluginViewMetrics();
    const recordInput = vi.spyOn(metrics, "recordInput");
    const root = document.createElement("div");
    root.setAttribute("data-daintree-plugin-owner", "acme");
    document.body.appendChild(root);
    const stop = startPluginInputTracking(document, metrics);
    root.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    stop();
    expect(recordInput).not.toHaveBeenCalled();
  });
});
