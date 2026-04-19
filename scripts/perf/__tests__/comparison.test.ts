import { describe, expect, it } from "vitest";
import { mannWhitneyU, cohensD, compareSamples } from "../lib/comparison";

describe("Mann-Whitney U", () => {
  it("returns high p-value for identical samples", () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    const { u, pValue } = mannWhitneyU(a, b);
    expect(u).toBe(4.5);
    expect(pValue).toBeGreaterThan(0.9);
  });

  it("detects clear separation with low p-value", () => {
    const a = [10, 12, 14, 16, 18];
    const b = [1, 2, 3, 4, 5];
    const { u, pValue } = mannWhitneyU(a, b, { exact: false });
    expect(pValue).toBeLessThan(0.05);
  });

  it("handles empty arrays gracefully", () => {
    const { u, pValue } = mannWhitneyU([], [1, 2]);
    expect(u).toBe(0);
    expect(pValue).toBe(1);
  });

  it("handles ties correctly", () => {
    const a = [5, 5, 5, 5];
    const b = [5, 5, 5, 5];
    const { pValue } = mannWhitneyU(a, b, { exact: false });
    expect(pValue).toBe(1);
  });

  it("works with unequal sample sizes", () => {
    const a = [10, 20, 30];
    const b = [1, 2, 3, 4, 5];
    const { u, pValue } = mannWhitneyU(a, b, { exact: false });
    expect(pValue).toBeLessThan(0.05);
  });
});

describe("Cohen's d", () => {
  it("returns 0 for identical means and spread", () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    expect(cohensD(a, b)).toBe(0);
  });

  it("returns positive d when first sample is larger", () => {
    const a = [10, 12, 14, 16, 18];
    const b = [1, 2, 3, 4, 5];
    const d = cohensD(a, b);
    expect(d).toBeGreaterThan(2);
  });

  it("returns 0 for zero pooled variance", () => {
    const a = [5, 5, 5];
    const b = [5, 5, 5];
    expect(cohensD(a, b)).toBe(0);
  });
});

describe("compareSamples", () => {
  it("detects no regression when samples are similar", () => {
    const result = compareSamples(
      { label: "head", durations: [100, 102, 98, 101, 99] },
      { label: "base", durations: [100, 101, 99, 102, 98] },
      0.05,
      0.5
    );
    expect(result.regression).toBe(false);
  });

  it("detects regression when head is significantly worse", () => {
    const head = Array.from({ length: 15 }, (_, i) => 200 + i * 2);
    const base = Array.from({ length: 15 }, (_, i) => 100 + i * 2);
    const result = compareSamples(
      { label: "head", durations: head },
      { label: "base", durations: base },
      0.05,
      0.5
    );
    expect(result.significant).toBe(true);
    expect(result.regression).toBe(true);
  });

  it("does not flag regression when head is better", () => {
    const head = Array.from({ length: 10 }, (_, i) => 50 + i);
    const base = Array.from({ length: 10 }, (_, i) => 100 + i);
    const result = compareSamples(
      { label: "head", durations: head },
      { label: "base", durations: base },
      0.05,
      0.5
    );
    expect(result.regression).toBe(false);
  });
});
