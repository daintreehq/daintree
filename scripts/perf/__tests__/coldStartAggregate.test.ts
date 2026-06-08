import { describe, expect, it } from "vitest";
import { aggregate, normalizeLoafSourceURL, type RunData } from "../lib/coldStartAggregate";
import { PERF_MARKS } from "../../../shared/perf/marks";

function makeRun(overrides: Partial<RunData>): RunData {
  return {
    index: 0,
    durationMs: 1000,
    marks: [],
    ...overrides,
  };
}

describe("cold-start aggregate", () => {
  it("emits null cls and osToAppBoot fields when no marks are present", () => {
    const agg = aggregate([
      makeRun({
        marks: [
          { mark: PERF_MARKS.APP_BOOT_START, timestamp: "t", elapsedMs: 0 },
          { mark: PERF_MARKS.RENDERER_READY, timestamp: "t", elapsedMs: 800 },
        ],
      }),
    ]);

    expect(agg.cls).toBeNull();
    expect(agg.osToAppBoot).toBeNull();
    expect(agg.loaf).toEqual({});
  });

  it("computes the window-show phase pairs from main_window_shown", () => {
    const agg = aggregate([
      makeRun({
        marks: [
          { mark: PERF_MARKS.APP_BOOT_START, timestamp: "t", elapsedMs: 0 },
          { mark: PERF_MARKS.MAIN_WINDOW_CREATED, timestamp: "t", elapsedMs: 100 },
          { mark: PERF_MARKS.MAIN_WINDOW_SHOWN, timestamp: "t", elapsedMs: 350 },
        ],
      }),
    ]);

    expect(agg.phaseDurations["boot → main_window_shown"].p50Ms).toBe(350);
    expect(agg.phaseDurations["main_window_created → main_window_shown"].p50Ms).toBe(250);
  });

  it("omits the window-show phase pairs when main_window_shown is absent", () => {
    const agg = aggregate([
      makeRun({
        marks: [
          { mark: PERF_MARKS.APP_BOOT_START, timestamp: "t", elapsedMs: 0 },
          { mark: PERF_MARKS.MAIN_WINDOW_CREATED, timestamp: "t", elapsedMs: 100 },
        ],
      }),
    ]);

    expect(agg.phaseDurations["boot → main_window_shown"]).toBeUndefined();
    expect(agg.phaseDurations["main_window_created → main_window_shown"]).toBeUndefined();
  });

  it("groups long-animation-frame blocking time by topScripts[0].sourceURL", () => {
    const agg = aggregate([
      makeRun({
        marks: [
          {
            mark: "renderer_long_animation_frame",
            timestamp: "t",
            elapsedMs: 100,
            meta: {
              blockingDurationMs: 60,
              topScripts: [{ sourceURL: "app://./assets/vendor-react-abc.js" }],
            },
          },
          {
            mark: "renderer_long_animation_frame",
            timestamp: "t",
            elapsedMs: 200,
            meta: {
              blockingDurationMs: 80,
              topScripts: [{ sourceURL: "app://./assets/vendor-react-abc.js" }],
            },
          },
          {
            mark: "renderer_long_animation_frame",
            timestamp: "t",
            elapsedMs: 300,
            meta: {
              blockingDurationMs: 30,
              topScripts: [{ sourceURL: "app://./assets/index-xyz.js" }],
            },
          },
        ],
      }),
    ]);

    expect(Object.keys(agg.loaf).sort()).toEqual([
      "app://./assets/index-xyz.js",
      "app://./assets/vendor-react-abc.js",
    ]);
    expect(agg.loaf["app://./assets/vendor-react-abc.js"].frames).toBe(2);
    expect(agg.loaf["app://./assets/vendor-react-abc.js"].totalBlockingMs).toBe(140);
    expect(agg.loaf["app://./assets/index-xyz.js"].totalBlockingMs).toBe(30);
  });

  it("treats NaN/Infinity blockingDurationMs as 0 to keep stats from being poisoned", () => {
    const agg = aggregate([
      makeRun({
        marks: [
          {
            mark: "renderer_long_animation_frame",
            timestamp: "t",
            elapsedMs: 100,
            meta: {
              blockingDurationMs: Number.NaN,
              topScripts: [{ sourceURL: "app://./assets/x.js" }],
            },
          },
          {
            mark: "renderer_long_animation_frame",
            timestamp: "t",
            elapsedMs: 200,
            meta: {
              blockingDurationMs: 50,
              topScripts: [{ sourceURL: "app://./assets/x.js" }],
            },
          },
        ],
      }),
    ]);

    const stats = agg.loaf["app://./assets/x.js"];
    expect(stats.frames).toBe(2);
    expect(Number.isFinite(stats.totalBlockingMs)).toBe(true);
    expect(stats.totalBlockingMs).toBe(50);
    expect(Number.isFinite(stats.p95BlockingMs)).toBe(true);
  });

  it("falls back to <unknown> bucket when topScripts is missing or empty", () => {
    const agg = aggregate([
      makeRun({
        marks: [
          {
            mark: "renderer_long_animation_frame",
            timestamp: "t",
            elapsedMs: 100,
            meta: { blockingDurationMs: 25, topScripts: [] },
          },
          {
            mark: "renderer_long_animation_frame",
            timestamp: "t",
            elapsedMs: 200,
            meta: { blockingDurationMs: 15 },
          },
        ],
      }),
    ]);

    expect(agg.loaf["<unknown>"].frames).toBe(2);
    expect(agg.loaf["<unknown>"].totalBlockingMs).toBe(40);
  });

  it("aggregates renderer_cls_final per run into p50/p95/mean/max", () => {
    const agg = aggregate([
      makeRun({
        index: 0,
        marks: [
          {
            mark: PERF_MARKS.RENDERER_CLS_FINAL,
            timestamp: "t",
            elapsedMs: 500,
            meta: { cumulativeCls: 0.02, sampleCount: 1 },
          },
        ],
      }),
      makeRun({
        index: 1,
        marks: [
          {
            mark: PERF_MARKS.RENDERER_CLS_FINAL,
            timestamp: "t",
            elapsedMs: 500,
            meta: { cumulativeCls: 0.06, sampleCount: 2 },
          },
        ],
      }),
      makeRun({
        index: 2,
        marks: [
          {
            mark: PERF_MARKS.RENDERER_CLS_FINAL,
            timestamp: "t",
            elapsedMs: 500,
            meta: { cumulativeCls: 0.1, sampleCount: 3 },
          },
        ],
      }),
    ]);

    expect(agg.cls).not.toBeNull();
    expect(agg.cls!.runs).toBe(3);
    expect(agg.cls!.max).toBeCloseTo(0.1, 4);
    expect(agg.cls!.p50).toBeCloseTo(0.06, 4);
  });

  it("uses the latest renderer_cls_final per run when emitted multiple times", () => {
    const agg = aggregate([
      makeRun({
        marks: [
          {
            mark: PERF_MARKS.RENDERER_CLS_FINAL,
            timestamp: "t",
            elapsedMs: 400,
            meta: { cumulativeCls: 0.03 },
          },
          {
            mark: PERF_MARKS.RENDERER_CLS_FINAL,
            timestamp: "t",
            elapsedMs: 600,
            meta: { cumulativeCls: 0.07 },
          },
        ],
      }),
    ]);

    expect(agg.cls!.max).toBeCloseTo(0.07, 4);
  });

  it("collects osToAppBootMs from APP_BOOT_START meta", () => {
    const agg = aggregate([
      makeRun({
        marks: [
          {
            mark: PERF_MARKS.APP_BOOT_START,
            timestamp: "t",
            elapsedMs: 0,
            meta: { osToAppBootMs: 850 },
          },
        ],
      }),
      makeRun({
        marks: [
          {
            mark: PERF_MARKS.APP_BOOT_START,
            timestamp: "t",
            elapsedMs: 0,
            meta: { osToAppBootMs: 1200 },
          },
        ],
      }),
    ]);

    expect(agg.osToAppBoot).not.toBeNull();
    expect(agg.osToAppBoot!.runs).toBe(2);
    expect(agg.osToAppBoot!.maxMs).toBe(1200);
  });

  it("ignores APP_BOOT_START marks without osToAppBootMs meta (no spawn anchor)", () => {
    const agg = aggregate([
      makeRun({
        marks: [{ mark: PERF_MARKS.APP_BOOT_START, timestamp: "t", elapsedMs: 0 }],
      }),
      makeRun({
        marks: [
          {
            mark: PERF_MARKS.APP_BOOT_START,
            timestamp: "t",
            elapsedMs: 0,
            meta: { osToAppBootMs: 0 },
          },
        ],
      }),
    ]);

    expect(agg.osToAppBoot).toBeNull();
  });

  it("excludes degraded runs from mark/phase aggregates but includes ipc samples", () => {
    const agg = aggregate([
      makeRun({
        index: 0,
        degraded: true,
        marks: [
          {
            mark: "ipc_request_sample",
            timestamp: "t",
            elapsedMs: 100,
            meta: { channel: "test", durationMs: 5 },
          },
          {
            mark: PERF_MARKS.APP_BOOT_START,
            timestamp: "t",
            elapsedMs: 0,
            meta: { osToAppBootMs: 999 },
          },
        ],
      }),
      makeRun({
        index: 1,
        marks: [
          { mark: PERF_MARKS.APP_BOOT_START, timestamp: "t", elapsedMs: 0 },
          { mark: PERF_MARKS.RENDERER_READY, timestamp: "t", elapsedMs: 500 },
        ],
      }),
    ]);

    expect(agg.ipc.test.samples).toBe(1);
    // Degraded run's APP_BOOT_START is not visited for marks/osToAppBoot.
    expect(agg.osToAppBoot).toBeNull();
    expect(agg.marks[PERF_MARKS.RENDERER_READY]).toBeDefined();
  });
});

describe("cache-kind bucketing", () => {
  it("splits successful runs into cold and warm buckets by cacheKind", () => {
    const agg = aggregate([
      makeRun({ index: 0, durationMs: 1000, cacheKind: "cold", cacheFileCount: 0 }),
      makeRun({ index: 1, durationMs: 1200, cacheKind: "cold", cacheFileCount: 0 }),
      makeRun({ index: 2, durationMs: 800, cacheKind: "warm", cacheFileCount: 42 }),
      makeRun({ index: 3, durationMs: 820, cacheKind: "warm", cacheFileCount: 44 }),
    ]);

    expect(agg.byCacheKind.cold).not.toBeNull();
    expect(agg.byCacheKind.warm).not.toBeNull();
    expect(agg.byCacheKind.cold!.runs).toBe(2);
    expect(agg.byCacheKind.warm!.runs).toBe(2);
    // Warm bucket should be faster than cold here, and its median file count > 0.
    expect(agg.byCacheKind.warm!.meanMs).toBeLessThan(agg.byCacheKind.cold!.meanMs);
    expect(agg.byCacheKind.warm!.medianCacheFileCount).toBeGreaterThan(0);
    expect(agg.byCacheKind.cold!.medianCacheFileCount).toBe(0);
  });

  it("leaves the warm bucket null when all runs are cold", () => {
    const agg = aggregate([
      makeRun({ index: 0, durationMs: 1000, cacheKind: "cold" }),
      makeRun({ index: 1, durationMs: 1100, cacheKind: "cold" }),
    ]);

    expect(agg.byCacheKind.cold).not.toBeNull();
    expect(agg.byCacheKind.cold!.runs).toBe(2);
    expect(agg.byCacheKind.warm).toBeNull();
  });

  it("defaults runs without an explicit cacheKind to the cold bucket", () => {
    const agg = aggregate([
      makeRun({ index: 0, durationMs: 1000 }),
      makeRun({ index: 1, durationMs: 1050 }),
    ]);

    expect(agg.byCacheKind.cold).not.toBeNull();
    expect(agg.byCacheKind.cold!.runs).toBe(2);
    expect(agg.byCacheKind.warm).toBeNull();
  });

  it("excludes failed runs from both cache-kind buckets", () => {
    const agg = aggregate([
      makeRun({ index: 0, durationMs: 900, cacheKind: "warm", cacheFileCount: 10 }),
      makeRun({ index: 1, durationMs: -1, failed: true, cacheKind: "warm" }),
    ]);

    expect(agg.byCacheKind.warm).not.toBeNull();
    expect(agg.byCacheKind.warm!.runs).toBe(1);
  });

  it("excludes degraded runs from cache-kind buckets (wall-clock fallback skews durations)", () => {
    const agg = aggregate([
      makeRun({ index: 0, durationMs: 800, cacheKind: "warm", cacheFileCount: 10 }),
      makeRun({
        index: 1,
        durationMs: 9999,
        degraded: true,
        cacheKind: "warm",
        cacheFileCount: 10,
      }),
    ]);

    expect(agg.byCacheKind.warm).not.toBeNull();
    expect(agg.byCacheKind.warm!.runs).toBe(1);
    expect(agg.byCacheKind.warm!.meanMs).toBe(800);
  });

  it("guards bucket stats against a malformed (NaN) duration", () => {
    const agg = aggregate([
      makeRun({ index: 0, durationMs: 1000, cacheKind: "cold" }),
      makeRun({ index: 1, durationMs: Number.NaN as unknown as number, cacheKind: "cold" }),
    ]);

    expect(agg.byCacheKind.cold).not.toBeNull();
    expect(agg.byCacheKind.cold!.runs).toBe(1);
    expect(Number.isFinite(agg.byCacheKind.cold!.meanMs)).toBe(true);
    expect(agg.byCacheKind.cold!.meanMs).toBe(1000);
  });

  it("computes the bucket median cacheFileCount and ignores missing counts", () => {
    const agg = aggregate([
      makeRun({ index: 0, durationMs: 800, cacheKind: "warm", cacheFileCount: 40 }),
      makeRun({ index: 1, durationMs: 810, cacheKind: "warm", cacheFileCount: 50 }),
      // No cacheFileCount on this run — excluded from the median, not counted as 0.
      makeRun({ index: 2, durationMs: 820, cacheKind: "warm" }),
    ]);

    expect(agg.byCacheKind.warm!.runs).toBe(3);
    expect(agg.byCacheKind.warm!.medianCacheFileCount).toBe(45);
  });
});

describe("normalizeLoafSourceURL", () => {
  it("strips 8-char lowercase hex Vite hash suffix before .js", () => {
    expect(normalizeLoafSourceURL("app://./assets/vendor-xterm-BcD3kf9a.js")).toBe(
      "app://./assets/vendor-xterm.js"
    );
    expect(normalizeLoafSourceURL("app://./assets/index-a1b2c3d4.js")).toBe(
      "app://./assets/index.js"
    );
  });

  it("strips hashes that include uppercase hex chars (case-insensitive)", () => {
    expect(normalizeLoafSourceURL("app://./assets/vendor-react-ABCDEF12.js")).toBe(
      "app://./assets/vendor-react.js"
    );
  });

  it("strips hashes from .css chunks too", () => {
    expect(normalizeLoafSourceURL("app://./assets/styles-deadbeef.css")).toBe(
      "app://./assets/styles.css"
    );
  });

  it("preserves query strings while stripping the hash", () => {
    expect(normalizeLoafSourceURL("app://./assets/index-a1b2c3d4.js?v=1")).toBe(
      "app://./assets/index.js?v=1"
    );
  });

  it("does not modify URLs without a recognizable 8-char hash", () => {
    // Short fake hash (3 chars) — does not match the 8-char pattern, passes through.
    expect(normalizeLoafSourceURL("app://./assets/vendor-react-abc.js")).toBe(
      "app://./assets/vendor-react-abc.js"
    );
    // No hash at all.
    expect(normalizeLoafSourceURL("app://./assets/index.js")).toBe("app://./assets/index.js");
    // Unknown sentinel.
    expect(normalizeLoafSourceURL("<unknown>")).toBe("<unknown>");
    // Empty string passes through.
    expect(normalizeLoafSourceURL("")).toBe("");
  });

  it("only strips the trailing hash, not hash-like substrings elsewhere in the path", () => {
    expect(normalizeLoafSourceURL("app://./assets/abcdef12/index.js")).toBe(
      "app://./assets/abcdef12/index.js"
    );
  });
});

describe("LoAF aggregation with build-hash normalization", () => {
  it("merges chunks from different builds with same logical name", () => {
    const agg = aggregate([
      makeRun({
        marks: [
          {
            mark: "renderer_long_animation_frame",
            timestamp: "t",
            elapsedMs: 100,
            meta: {
              blockingDurationMs: 50,
              topScripts: [{ sourceURL: "app://./assets/vendor-xterm-BcD3kf9a.js" }],
            },
          },
          {
            mark: "renderer_long_animation_frame",
            timestamp: "t",
            elapsedMs: 200,
            meta: {
              blockingDurationMs: 70,
              topScripts: [{ sourceURL: "app://./assets/vendor-xterm-Ef5g6h7i.js" }],
            },
          },
        ],
      }),
    ]);

    expect(Object.keys(agg.loaf)).toEqual(["app://./assets/vendor-xterm.js"]);
    expect(agg.loaf["app://./assets/vendor-xterm.js"].frames).toBe(2);
    expect(agg.loaf["app://./assets/vendor-xterm.js"].totalBlockingMs).toBe(120);
  });
});

describe("event_loop_lag aggregation", () => {
  it("aggregates lagMs samples into samples/p50/p95/mean/max/total", () => {
    const agg = aggregate([
      makeRun({
        marks: [
          { mark: "event_loop_lag", timestamp: "t", elapsedMs: 6000, meta: { lagMs: 120 } },
          { mark: "event_loop_lag", timestamp: "t", elapsedMs: 7000, meta: { lagMs: 250 } },
          { mark: "event_loop_lag", timestamp: "t", elapsedMs: 8000, meta: { lagMs: 180 } },
        ],
      }),
    ]);

    expect(agg.eventLoopLag).not.toBeNull();
    expect(agg.eventLoopLag!.samples).toBe(3);
    expect(agg.eventLoopLag!.maxMs).toBe(250);
    expect(agg.eventLoopLag!.totalAccumulatedMs).toBe(550);
    expect(agg.eventLoopLag!.meanMs).toBeCloseTo(550 / 3, 3);
  });

  it("returns null eventLoopLag when no samples are present", () => {
    const agg = aggregate([
      makeRun({
        marks: [
          { mark: PERF_MARKS.APP_BOOT_START, timestamp: "t", elapsedMs: 0 },
          { mark: PERF_MARKS.RENDERER_READY, timestamp: "t", elapsedMs: 500 },
        ],
      }),
    ]);

    expect(agg.eventLoopLag).toBeNull();
  });

  it("skips event_loop_lag records with malformed meta.lagMs", () => {
    const agg = aggregate([
      makeRun({
        marks: [
          { mark: "event_loop_lag", timestamp: "t", elapsedMs: 6000, meta: { lagMs: Number.NaN } },
          {
            mark: "event_loop_lag",
            timestamp: "t",
            elapsedMs: 7000,
            meta: { lagMs: Number.POSITIVE_INFINITY },
          },
          { mark: "event_loop_lag", timestamp: "t", elapsedMs: 8000, meta: { lagMs: "200" } },
          { mark: "event_loop_lag", timestamp: "t", elapsedMs: 9000, meta: {} },
          { mark: "event_loop_lag", timestamp: "t", elapsedMs: 10000, meta: { lagMs: 150 } },
          { mark: "event_loop_lag", timestamp: "t", elapsedMs: 11000, meta: { lagMs: -5 } },
        ],
      }),
    ]);

    expect(agg.eventLoopLag).not.toBeNull();
    expect(agg.eventLoopLag!.samples).toBe(1);
    expect(agg.eventLoopLag!.maxMs).toBe(150);
  });

  it("rejects negative blockingDurationMs without poisoning totals", () => {
    const agg = aggregate([
      makeRun({
        marks: [
          {
            mark: "renderer_long_animation_frame",
            timestamp: "t",
            elapsedMs: 100,
            meta: {
              blockingDurationMs: -100,
              topScripts: [{ sourceURL: "app://./assets/x.js" }],
            },
          },
          {
            mark: "renderer_long_animation_frame",
            timestamp: "t",
            elapsedMs: 200,
            meta: {
              blockingDurationMs: 50,
              topScripts: [{ sourceURL: "app://./assets/x.js" }],
            },
          },
        ],
      }),
    ]);

    expect(agg.loaf["app://./assets/x.js"].totalBlockingMs).toBe(50);
    expect(agg.loaf["app://./assets/x.js"].totalBlockingMs).toBeGreaterThanOrEqual(0);
  });

  it("skips marks with non-finite or negative elapsedMs so they don't poison p50/p95", () => {
    const agg = aggregate([
      makeRun({
        marks: [
          // Cast through unknown so we can simulate malformed NDJSON.
          {
            mark: PERF_MARKS.HYDRATE_COMPLETE,
            timestamp: "t",
            elapsedMs: Number.NaN as unknown as number,
          },
          {
            mark: PERF_MARKS.HYDRATE_COMPLETE,
            timestamp: "t",
            elapsedMs: 500,
          },
        ],
      }),
      makeRun({
        marks: [
          {
            mark: PERF_MARKS.HYDRATE_COMPLETE,
            timestamp: "t",
            elapsedMs: -50,
          },
          {
            mark: PERF_MARKS.HYDRATE_COMPLETE,
            timestamp: "t",
            elapsedMs: 700,
          },
        ],
      }),
    ]);

    const stats = agg.marks[PERF_MARKS.HYDRATE_COMPLETE];
    expect(stats.runs).toBe(2);
    expect(Number.isFinite(stats.meanMs)).toBe(true);
    expect(stats.meanMs).toBe(600);
  });

  it("excludes event_loop_lag from the generic marks bucket", () => {
    // Without the dedicated bucket, the generic markElapsed loop would record
    // event_loop_lag.elapsedMs (since-boot timestamp) into agg.marks — which
    // tells us nothing about lag severity. Confirm we suppress it.
    const agg = aggregate([
      makeRun({
        marks: [
          { mark: PERF_MARKS.APP_BOOT_START, timestamp: "t", elapsedMs: 0 },
          { mark: "event_loop_lag", timestamp: "t", elapsedMs: 6000, meta: { lagMs: 150 } },
        ],
      }),
    ]);

    expect(agg.marks["event_loop_lag"]).toBeUndefined();
  });
});
