import { describe, it, expect } from "vitest";
import { computeFrecencyScore, FRECENCY_HALF_LIFE_MS } from "../frecency.js";

describe("computeFrecencyScore", () => {
  const NOW = 1_700_000_000_000;

  it("adds 1.0 increment on access with no decay when just accessed", () => {
    const score = computeFrecencyScore(3.0, NOW, NOW);
    expect(score).toBeCloseTo(4.0);
  });

  it("decays score by half after one half-life", () => {
    const score = computeFrecencyScore(4.0, NOW - FRECENCY_HALF_LIFE_MS, NOW);
    expect(score).toBeCloseTo(3.0);
  });

  it("decays score by 75% after two half-lives", () => {
    const score = computeFrecencyScore(4.0, NOW - 2 * FRECENCY_HALF_LIFE_MS, NOW);
    expect(score).toBeCloseTo(2.0);
  });

  it("handles zero lastAccessedAt by treating as accessed now (no decay)", () => {
    const score = computeFrecencyScore(3.0, 0, NOW);
    expect(score).toBeCloseTo(4.0);
  });

  it("handles NaN score gracefully", () => {
    const score = computeFrecencyScore(NaN, NOW, NOW);
    expect(score).toBeCloseTo(1.0);
  });

  it("handles negative score gracefully", () => {
    const score = computeFrecencyScore(-5.0, NOW, NOW);
    expect(score).toBeCloseTo(1.0);
  });

  it("handles Infinity score gracefully", () => {
    const score = computeFrecencyScore(Infinity, NOW, NOW);
    expect(score).toBeCloseTo(1.0);
  });

  it("produces monotonically decreasing scores with increasing elapsed time", () => {
    const scores = [0, 1, 2, 5, 10, 30].map((days) =>
      computeFrecencyScore(5.0, NOW - days * 24 * 60 * 60 * 1000, NOW)
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]!);
    }
  });

  it("cold-start score of 3.0 with immediate access gives 4.0", () => {
    const score = computeFrecencyScore(3.0, NOW, NOW);
    expect(score).toBeCloseTo(4.0);
  });
});
