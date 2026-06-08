import { describe, expect, it } from "vitest";
import { averageMetrics, mean, percentile, stdDev, round } from "../lib/stats";

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
