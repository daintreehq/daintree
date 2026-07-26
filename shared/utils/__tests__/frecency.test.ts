import { describe, it, expect } from "vitest";
import {
  decayFrecencyScore,
  bumpFrecencyScore,
  FRECENCY_HALF_LIFE_MS,
  FRECENCY_ACCESS_DEBOUNCE_MS,
  FRECENCY_COLD_START,
  FRECENCY_INCREMENT,
} from "../frecency.js";

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe("decayFrecencyScore", () => {
  it("returns the score unchanged when just written", () => {
    expect(decayFrecencyScore(3.0, NOW, NOW)).toBeCloseTo(3.0);
  });

  it("halves after one half-life and quarters after two", () => {
    expect(decayFrecencyScore(4.0, NOW - FRECENCY_HALF_LIFE_MS, NOW)).toBeCloseTo(2.0);
    expect(decayFrecencyScore(4.0, NOW - 2 * FRECENCY_HALF_LIFE_MS, NOW)).toBeCloseTo(1.0);
  });

  it("treats a non-positive timestamp as current (legacy rows never invent decay)", () => {
    expect(decayFrecencyScore(3.0, 0, NOW)).toBeCloseTo(3.0);
    expect(decayFrecencyScore(3.0, -5, NOW)).toBeCloseTo(3.0);
  });

  it("never decays backwards when the clock reads earlier than the write", () => {
    expect(decayFrecencyScore(3.0, NOW + 60_000, NOW)).toBeCloseTo(3.0);
  });

  it("sanitizes NaN, negative, and Infinity scores to zero", () => {
    expect(decayFrecencyScore(NaN, NOW, NOW)).toBe(0);
    expect(decayFrecencyScore(-5, NOW, NOW)).toBe(0);
    expect(decayFrecencyScore(Infinity, NOW, NOW)).toBe(0);
  });

  it("decreases monotonically with elapsed time", () => {
    const scores = [0, 1, 2, 5, 10, 30].map((days) =>
      decayFrecencyScore(5.0, NOW - days * DAY_MS, NOW)
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]!);
    }
  });

  it("keeps the relative order of two untouched projects as time advances", () => {
    // Effective order depends only on the (score, timestamp) pairs, never on
    // when the comparison runs — the palette relies on this to avoid ticking.
    const a = { score: 10, at: NOW - 3 * DAY_MS };
    const b = { score: 2, at: NOW - 1 * DAY_MS };
    for (const probe of [NOW, NOW + DAY_MS, NOW + 30 * DAY_MS]) {
      const orderedAbove =
        decayFrecencyScore(a.score, a.at, probe) > decayFrecencyScore(b.score, b.at, probe);
      expect(orderedAbove).toBe(
        decayFrecencyScore(a.score, a.at, NOW) > decayFrecencyScore(b.score, b.at, NOW)
      );
    }
  });

  it("lets a hot new project overtake a dormant heavy one at the crossover", () => {
    // A heavy project abandoned at NOW vs a fresh one bumped daily: with a
    // 4-day half-life the dormant score must fall below steady daily use well
    // inside two weeks — the staleness complaint the rework exists to fix.
    const heavyAbandoned = 30;
    let newcomer = FRECENCY_COLD_START;
    let newcomerAt = NOW;
    let crossedAt: number | null = null;
    for (let day = 1; day <= 21; day++) {
      const t = NOW + day * DAY_MS;
      newcomer = bumpFrecencyScore(newcomer, newcomerAt, t - DAY_MS, t);
      newcomerAt = t;
      if (crossedAt === null && newcomer > decayFrecencyScore(heavyAbandoned, NOW, t)) {
        crossedAt = day;
      }
    }
    expect(crossedAt).not.toBeNull();
    expect(crossedAt!).toBeLessThanOrEqual(14);
  });
});

describe("bumpFrecencyScore", () => {
  it("adds one increment when the previous open is outside the debounce window", () => {
    const score = bumpFrecencyScore(3.0, NOW, NOW - FRECENCY_ACCESS_DEBOUNCE_MS, NOW);
    expect(score).toBeCloseTo(3.0 + FRECENCY_INCREMENT);
  });

  it("suppresses the increment inside the debounce window but still decays", () => {
    const lastOpened = NOW - FRECENCY_ACCESS_DEBOUNCE_MS + 1;
    const score = bumpFrecencyScore(4.0, NOW - FRECENCY_HALF_LIFE_MS, lastOpened, NOW);
    expect(score).toBeCloseTo(2.0);
  });

  it("counts a first-ever open (no previous lastOpened)", () => {
    expect(bumpFrecencyScore(FRECENCY_COLD_START, NOW, 0, NOW)).toBeCloseTo(
      FRECENCY_COLD_START + FRECENCY_INCREMENT
    );
  });

  it("never lowers the effective score of the accessed project", () => {
    const before = decayFrecencyScore(4.0, NOW - DAY_MS, NOW);
    const after = bumpFrecencyScore(4.0, NOW - DAY_MS, NOW - 1000, NOW);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("rapid A↔B toggling adds at most one increment per window", () => {
    let score = 2.0;
    let accessedAt = NOW - DAY_MS;
    let lastOpened = NOW - DAY_MS;
    // Six switches within five minutes: only the first may count.
    for (let i = 0; i < 6; i++) {
      const t = NOW + i * 30_000;
      score = bumpFrecencyScore(score, accessedAt, lastOpened, t);
      accessedAt = t;
      lastOpened = t;
    }
    const oneCountedCeiling = decayFrecencyScore(2.0, NOW - DAY_MS, NOW) + FRECENCY_INCREMENT;
    expect(score).toBeLessThanOrEqual(oneCountedCeiling + 1e-9);
  });
});
