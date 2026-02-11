// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markRendererPerformance } from "../performance";

describe("markRendererPerformance", () => {
  const originalCapture = process.env.CANOPY_PERF_CAPTURE;

  beforeEach(() => {
    delete window.__CANOPY_PERF_MARKS__;
    process.env.CANOPY_PERF_CAPTURE = "";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.CANOPY_PERF_CAPTURE = originalCapture;
    delete window.__CANOPY_PERF_MARKS__;
    vi.restoreAllMocks();
  });

  it("does not allocate mark buffer when capture is disabled and no consumer exists", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    markRendererPerformance("test-mark");

    expect(window.__CANOPY_PERF_MARKS__).toBeUndefined();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("appends marks when a consumer buffer already exists", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    window.__CANOPY_PERF_MARKS__ = [];

    markRendererPerformance("buffered-mark", { value: 1 });

    expect(window.__CANOPY_PERF_MARKS__).toHaveLength(1);
    expect(window.__CANOPY_PERF_MARKS__?.[0]).toEqual(
      expect.objectContaining({
        mark: "buffered-mark",
        meta: { value: 1 },
      })
    );
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("captures and logs marks when perf capture is enabled", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    process.env.CANOPY_PERF_CAPTURE = "1";

    markRendererPerformance("captured-mark", { value: 2 });

    expect(window.__CANOPY_PERF_MARKS__).toHaveLength(1);
    expect(debugSpy).toHaveBeenCalledWith("[perf]", "captured-mark", { value: 2 });
  });
});
