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
import { startLongTaskMonitor } from "../longTaskMonitor";

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

function emitLoafEntry(opts: {
  duration: number;
  blockingDuration?: number;
  scripts?: ScriptFixture[];
  startTime?: number;
}) {
  const entry = {
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

  observerCallback?.({
    getEntries: () => [entry as unknown as PerformanceEntry],
  });
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

  it("subscribes to long-animation-frame with the configured durationThreshold", () => {
    startLongTaskMonitor(120);
    expect(lastObserveOptions).toEqual({
      type: "long-animation-frame",
      durationThreshold: 120,
    });
  });

  it("suppresses warnings during first 5 seconds", () => {
    mockNow = 2000;
    startLongTaskMonitor(100);
    emitLoafEntry({ duration: 150 });
    expect(logWarn).not.toHaveBeenCalled();
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

  it("does not call markRendererPerformance when capture is disabled", () => {
    mockNow = 6000;
    startLongTaskMonitor(100);
    emitLoafEntry({ duration: 150 });
    expect(mockMarkRendererPerformance).not.toHaveBeenCalled();
  });
});
