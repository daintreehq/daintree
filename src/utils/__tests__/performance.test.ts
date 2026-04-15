// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRendererPerfCaptureEnabled,
  markRendererPerformance,
  startRendererMemoryMonitor,
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
    expect(window.__DAINTREE_PERF_MARKS__![0].mark).toBe("test-span:start");
    expect(window.__DAINTREE_PERF_MARKS__![0].meta).toEqual({ key: "val" });
    expect(window.__DAINTREE_PERF_MARKS__![1].mark).toBe("test-span:end");
    expect(window.__DAINTREE_PERF_MARKS__![1].meta).toEqual(
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
    expect(window.__DAINTREE_PERF_MARKS__![0].mark).toBe("fail-span:start");
    expect(window.__DAINTREE_PERF_MARKS__![1].mark).toBe("fail-span:end");
  });

  it("starts renderer memory monitor without throwing when memory API is unavailable", () => {
    const stop = startRendererMemoryMonitor(10);
    expect(typeof stop).toBe("function");
    stop();
  });
});
