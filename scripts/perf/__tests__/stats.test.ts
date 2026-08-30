import { describe, expect, it } from "vitest";
import { aggregateMetrics, averageMetrics, mean, percentile, stdDev, round } from "../lib/stats";

describe("aggregateMetrics", () => {
  it("reports max and sum, which is the whole reason it exists", () => {
    // The motivating case: one iteration spawns 20 processes, fifteen spawn
    // none. A mean of 1.25 reads as "about one spawn" and hides the storm —
    // that shape is exactly how a 1.6s idle spawn loop went unnoticed.
    const samples = [{ gitSpawns: 20 }, ...Array.from({ length: 15 }, () => ({ gitSpawns: 0 }))];
    const stats = aggregateMetrics(samples);

    expect(stats.gitSpawns.max).toBe(20);
    expect(stats.gitSpawns.sum).toBe(20);
    expect(stats.gitSpawns.min).toBe(0);
    expect(stats.gitSpawns.count).toBe(16);
    expect(stats.gitSpawns.mean).toBeCloseTo(1.25);
  });

  it("divides by the metric's own occurrence count, not the sample count", () => {
    // A metric only some iterations emit must not be diluted toward zero by the
    // iterations that stayed silent.
    const stats = aggregateMetrics([{ a: 10 }, {}, { a: 20 }]);
    expect(stats.a.count).toBe(2);
    expect(stats.a.mean).toBe(15);
  });

  it("propagates a non-finite sample rather than hiding it", () => {
    // run.ts rejects these at collection, but if one ever reaches here it must
    // stay visible: a silently dropped NaN reads as a clean measurement.
    const stats = aggregateMetrics([{ a: 1 }, { a: Number.NaN }, { a: 3 }]);
    expect(Number.isNaN(stats.a.max)).toBe(true);
    expect(Number.isNaN(stats.a.sum)).toBe(true);
    expect(Number.isNaN(stats.a.mean)).toBe(true);
  });

  it("returns no entries for empty input, so the ±Infinity seeds never leak", () => {
    expect(aggregateMetrics([])).toEqual({});
    expect(aggregateMetrics([{}, {}])).toEqual({});
  });

  it("handles a single sample", () => {
    const stats = aggregateMetrics([{ a: 7 }]);
    expect(stats.a).toEqual({ mean: 7, max: 7, min: 7, sum: 7, count: 1 });
  });
});

describe("perf stats utilities", () => {
  it("computes percentile with interpolation", () => {
    const values = [10, 20, 30, 40];
    expect(percentile(values, 50)).toBe(25);
    expect(percentile(values, 95)).toBeCloseTo(38.5, 5);
  });

  it("handles empty and edge percentile inputs", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([3, 1, 2], 0)).toBe(1);
    expect(percentile([3, 1, 2], 100)).toBe(3);
  });

  it("computes mean, stddev, and rounding", () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(mean(values)).toBe(5);
    expect(stdDev(values)).toBeCloseTo(2, 5);
    expect(round(3.141592, 3)).toBe(3.142);
  });
});

describe("averageMetrics", () => {
  it("divides each metric by its own occurrence count, not the sample count", () => {
    // serializeMs appears once across four samples; it must average to its lone
    // value, not be diluted toward zero by the three samples that omit it.
    const samples = [{ serializeMs: 1000 }, {}, {}, {}];
    expect(averageMetrics(samples).serializeMs).toBe(1000);
  });

  it("averages metrics that appear in every sample", () => {
    const samples = [{ lag: 10 }, { lag: 20 }, { lag: 30 }];
    expect(averageMetrics(samples).lag).toBe(20);
  });

  it("handles disjoint metric keys across samples independently", () => {
    const samples = [{ a: 4 }, { b: 8 }, { a: 6 }];
    const result = averageMetrics(samples);
    expect(result.a).toBe(5);
    expect(result.b).toBe(8);
  });

  it("returns an empty object for no samples", () => {
    expect(averageMetrics([])).toEqual({});
  });
});
