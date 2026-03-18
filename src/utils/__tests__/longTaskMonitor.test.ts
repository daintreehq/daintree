// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let observerCallback: ((list: { getEntries: () => PerformanceEntry[] }) => void) | null = null;
let observerDisconnected = false;

class MockPerformanceObserver {
  constructor(callback: (list: { getEntries: () => PerformanceEntry[] }) => void) {
    observerCallback = callback;
    observerDisconnected = false;
  }
  observe() {}
  disconnect() {
    observerDisconnected = true;
  }
}

vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);

vi.mock("../logger", () => ({
  logWarn: vi.fn(),
}));

vi.mock("../performance", async (importOriginal) => {
  const original = await importOriginal<typeof import("../performance")>();
  return {
    ...original,
    RENDERER_T0: 0,
    isRendererPerfCaptureEnabled: vi.fn(() => false),
    markRendererPerformance: vi.fn(),
  };
});

describe("startLongTaskMonitor", () => {
  let logWarn: ReturnType<typeof vi.fn>;
  let markRendererPerformance: ReturnType<typeof vi.fn>;
  let isRendererPerfCaptureEnabled: ReturnType<typeof vi.fn>;
  let startLongTaskMonitor: typeof import("../longTaskMonitor").startLongTaskMonitor;
  let mockNow: number;

  beforeEach(async () => {
    mockNow = 0;
    vi.spyOn(performance, "now").mockImplementation(() => mockNow);
    observerCallback = null;
    observerDisconnected = false;

    const loggerMod = await import("../logger");
    logWarn = loggerMod.logWarn as ReturnType<typeof vi.fn>;
    logWarn.mockClear();

    const perfMod = await import("../performance");
    markRendererPerformance = perfMod.markRendererPerformance as ReturnType<typeof vi.fn>;
    markRendererPerformance.mockClear();
    isRendererPerfCaptureEnabled = perfMod.isRendererPerfCaptureEnabled as ReturnType<typeof vi.fn>;
    isRendererPerfCaptureEnabled.mockReturnValue(false);

    const monitorMod = await import("../longTaskMonitor");
    startLongTaskMonitor = monitorMod.startLongTaskMonitor;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function emitLongTask(duration: number) {
    observerCallback?.({
      getEntries: () => [{ name: "self", duration, startTime: mockNow } as PerformanceEntry],
    });
  }

  it("starts without CANOPY_PERF_CAPTURE and returns cleanup", () => {
    const stop = startLongTaskMonitor();
    expect(typeof stop).toBe("function");
    expect(observerCallback).not.toBeNull();
    stop();
    expect(observerDisconnected).toBe(true);
  });

  it("does not warn for tasks below threshold", () => {
    mockNow = 6000;
    startLongTaskMonitor(100);
    emitLongTask(80);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("suppresses warnings during first 5 seconds", () => {
    mockNow = 2000;
    startLongTaskMonitor(100);
    emitLongTask(150);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("warns after suppression window for tasks above threshold", () => {
    mockNow = 6000;
    startLongTaskMonitor(100);
    emitLongTask(150);
    expect(logWarn).toHaveBeenCalledWith("Renderer long task detected", {
      durationMs: 150,
      name: "self",
    });
  });

  it("rate-limits warnings to one per 10 seconds", () => {
    mockNow = 6000;
    startLongTaskMonitor(100);

    emitLongTask(150);
    expect(logWarn).toHaveBeenCalledTimes(1);

    mockNow = 7000;
    emitLongTask(150);
    expect(logWarn).toHaveBeenCalledTimes(1);

    mockNow = 17000;
    emitLongTask(150);
    expect(logWarn).toHaveBeenCalledTimes(2);
  });

  it("still calls markRendererPerformance when capture is enabled", () => {
    isRendererPerfCaptureEnabled.mockReturnValue(true);
    mockNow = 6000;
    startLongTaskMonitor(100);
    emitLongTask(150);

    expect(markRendererPerformance).toHaveBeenCalledWith("renderer_long_task", {
      name: "self",
      startTimeMs: 6000,
      durationMs: 150,
    });
  });

  it("does not call markRendererPerformance when capture is disabled", () => {
    mockNow = 6000;
    startLongTaskMonitor(100);
    emitLongTask(150);
    expect(markRendererPerformance).not.toHaveBeenCalled();
  });
});
