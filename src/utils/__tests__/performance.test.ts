// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRendererPerfCaptureEnabled,
  markRendererPerformance,
  startRendererMemoryMonitor,
  startSteadyStatePerfFlush,
  withRendererSpan,
} from "../performance";

describe("markRendererPerformance", () => {
  const originalCapture = process.env.DAINTREE_PERF_CAPTURE;

  beforeEach(() => {
    delete window.__DAINTREE_PERF_MARKS__;
    process.env.DAINTREE_PERF_CAPTURE = "";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.DAINTREE_PERF_CAPTURE = originalCapture;
    delete window.__DAINTREE_PERF_MARKS__;
    vi.restoreAllMocks();
  });

  it("does not allocate mark buffer when capture is disabled and no consumer exists", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    markRendererPerformance("test-mark");

    expect(window.__DAINTREE_PERF_MARKS__).toBeUndefined();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("appends marks when a consumer buffer already exists", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    window.__DAINTREE_PERF_MARKS__ = [];

    markRendererPerformance("buffered-mark", { value: 1 });

    expect(window.__DAINTREE_PERF_MARKS__).toHaveLength(1);
    expect(window.__DAINTREE_PERF_MARKS__?.[0]).toEqual(
      expect.objectContaining({
        mark: "buffered-mark",
        meta: { value: 1 },
      })
    );
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("captures and logs marks when perf capture is enabled", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    process.env.DAINTREE_PERF_CAPTURE = "1";

    markRendererPerformance("captured-mark", { value: 2 });

    expect(window.__DAINTREE_PERF_MARKS__).toHaveLength(1);
    expect(debugSpy).toHaveBeenCalledWith("[perf]", "captured-mark", { value: 2 });
  });

  it("lands marks on the User Timing timeline only during capture runs", () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const markSpy = vi.spyOn(performance, "mark");

    window.__DAINTREE_PERF_MARKS__ = [];
    markRendererPerformance("buffered-only");
    expect(markSpy).not.toHaveBeenCalled();

    process.env.DAINTREE_PERF_CAPTURE = "1";
    markRendererPerformance("timeline-mark", { value: 3 });
    expect(markSpy).toHaveBeenCalledWith("timeline-mark", { detail: { value: 3 } });
  });

  it("reports whether renderer perf capture is enabled", () => {
    process.env.DAINTREE_PERF_CAPTURE = "1";
    expect(isRendererPerfCaptureEnabled()).toBe(true);
    process.env.DAINTREE_PERF_CAPTURE = "0";
    expect(isRendererPerfCaptureEnabled()).toBe(false);
  });

  it("withRendererSpan records start and end marks on success", async () => {
    window.__DAINTREE_PERF_MARKS__ = [];

    const result = await withRendererSpan("test-span", async () => "ok", { key: "val" });

    expect(result).toBe("ok");
    expect(window.__DAINTREE_PERF_MARKS__).toHaveLength(2);
    expect(window.__DAINTREE_PERF_MARKS__![0]!.mark).toBe("test-span:start");
    expect(window.__DAINTREE_PERF_MARKS__![0]!.meta).toEqual({ key: "val" });
    expect(window.__DAINTREE_PERF_MARKS__![1]!.mark).toBe("test-span:end");
    expect(window.__DAINTREE_PERF_MARKS__![1]!.meta).toEqual(
      expect.objectContaining({ key: "val", durationMs: expect.any(Number) })
    );
  });

  it("withRendererSpan fires end mark even when task rejects", async () => {
    window.__DAINTREE_PERF_MARKS__ = [];

    await expect(
      withRendererSpan("fail-span", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(window.__DAINTREE_PERF_MARKS__).toHaveLength(2);
    expect(window.__DAINTREE_PERF_MARKS__![0]!.mark).toBe("fail-span:start");
    expect(window.__DAINTREE_PERF_MARKS__![1]!.mark).toBe("fail-span:end");
  });

  it("starts renderer memory monitor without throwing when memory API is unavailable", () => {
    const stop = startRendererMemoryMonitor(10);
    expect(typeof stop).toBe("function");
    stop();
  });

  it("caps the mark buffer by dropping the oldest entries", () => {
    window.__DAINTREE_PERF_MARKS__ = [];

    for (let i = 0; i < 2105; i++) {
      markRendererPerformance(`mark-${i}`);
    }

    const buffer = window.__DAINTREE_PERF_MARKS__!;
    expect(buffer.length).toBe(2000);
    expect(buffer[0]!.mark).toBe("mark-105");
    expect(buffer[buffer.length - 1]!.mark).toBe("mark-2104");
  });

  it("exposes __daintreeMarkPerf only under the E2E flag, routing through the mark buffer", async () => {
    vi.resetModules();
    const w = window as Window & { __DAINTREE_E2E_MODE__?: boolean };
    delete w.__daintreeMarkPerf;
    delete w.__DAINTREE_E2E_MODE__;
    await import("../performance");
    expect(w.__daintreeMarkPerf).toBeUndefined();

    vi.resetModules();
    w.__DAINTREE_E2E_MODE__ = true;
    try {
      await import("../performance");
      expect(typeof w.__daintreeMarkPerf).toBe("function");
      window.__DAINTREE_PERF_MARKS__ = [];
      w.__daintreeMarkPerf!("project_switch.nonce_painted", { switchId: "s1" });
      expect(window.__DAINTREE_PERF_MARKS__).toEqual([
        expect.objectContaining({
          mark: "project_switch.nonce_painted",
          meta: { switchId: "s1" },
        }),
      ]);
    } finally {
      delete w.__DAINTREE_E2E_MODE__;
      delete w.__daintreeMarkPerf;
      vi.resetModules();
    }
  });

  it("steady-state flush drains buffered marks on the interval during capture runs", () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, "debug").mockImplementation(() => {});
      process.env.DAINTREE_PERF_CAPTURE = "1";
      const flushMarks = vi.fn();
      (window as { electron?: unknown }).electron = { perf: { flushMarks } };

      const stop = startSteadyStatePerfFlush(1000);

      vi.advanceTimersByTime(1000);
      expect(flushMarks).not.toHaveBeenCalled();

      markRendererPerformance("steady-mark");
      vi.advanceTimersByTime(1000);
      expect(flushMarks).toHaveBeenCalledTimes(1);
      expect(flushMarks.mock.calls[0]![0].marks).toHaveLength(1);
      expect(window.__DAINTREE_PERF_MARKS__).toHaveLength(0);

      stop();
      markRendererPerformance("after-stop");
      vi.advanceTimersByTime(5000);
      expect(flushMarks).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      delete (window as { electron?: unknown }).electron;
    }
  });
});
