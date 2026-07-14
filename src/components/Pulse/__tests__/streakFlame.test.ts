import { describe, it, expect } from "vitest";
import { getStreakColor, getStreakTier } from "../StreakFlame";

// The tier hexes are the implementation's source of truth — asserting them here
// would just copy them. These tests cover what the hexes can't: that the tier
// boundaries land where they should, that every tier is visually distinct, and
// that each stop is theme-overridable with its legacy colour as the fallback.

const TIER_BOUNDARIES = [8, 15, 30, 60, 120, 240];
const TOKEN_FORM = /^var\(--pulse-streak-([1-7]), (#[0-9A-Fa-f]{6})\)$/;

function parse(days: number): { level: number; fallback: string } {
  const match = TOKEN_FORM.exec(getStreakColor(days));
  if (!match) throw new Error(`getStreakColor(${days}) is not a themeable token`);
  return { level: Number(match[1]), fallback: match[2]! };
}

describe("getStreakColor", () => {
  it("emits a themeable token carrying a hex fallback at every tier", () => {
    for (const days of [0, 1, 7, 8, 14, 15, 29, 30, 59, 60, 119, 120, 239, 240, 10_000]) {
      expect(getStreakColor(days)).toMatch(TOKEN_FORM);
    }
  });

  it("steps to the next tier exactly at each boundary, not before", () => {
    for (const boundary of TIER_BOUNDARIES) {
      const below = parse(boundary - 1);
      const at = parse(boundary);
      expect(at.level).toBe(below.level + 1);
      expect(at.fallback).not.toBe(below.fallback);
    }
  });

  it("holds one colour across the whole span of a tier", () => {
    // 8..14 is a full interior tier: every day in it resolves identically.
    const span = [8, 9, 12, 14].map((d) => getStreakColor(d));
    expect(new Set(span).size).toBe(1);
  });

  it("gives every tier a distinct colour", () => {
    const representatives = [1, 8, 15, 30, 60, 120, 240];
    const tokens = representatives.map((d) => getStreakColor(d));
    expect(new Set(tokens).size).toBe(representatives.length);
    expect(new Set(representatives.map((d) => parse(d).fallback)).size).toBe(
      representatives.length
    );
  });

  it("rises monotonically with streak length", () => {
    const levels = [0, 8, 15, 30, 60, 120, 240, 10_000].map((d) => parse(d).level);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]!).toBeGreaterThanOrEqual(levels[i - 1]!);
    }
  });

  it("clamps a zero or negative streak to the base tier", () => {
    expect(parse(0).level).toBe(1);
    expect(parse(-5).level).toBe(1);
    expect(getStreakColor(0)).toBe(getStreakColor(1));
  });

  it("keeps 240+ in one open-ended top tier", () => {
    expect(getStreakColor(10_000)).toBe(getStreakColor(240));
    expect(parse(240).level).toBe(7);
  });

  it("never borrows the accent token (issue #9820)", () => {
    // The release chip in the same focus region already spends the accent; a
    // flame that co-opted it would put two accent signals in one region.
    for (const days of [1, 8, 15, 30, 60, 120, 240]) {
      expect(getStreakColor(days)).not.toContain("--color-accent-primary");
    }
  });
});

describe("getStreakTier", () => {
  it("maps each boundary to a successive tier and spans 1..7", () => {
    const tiers = [0, 8, 15, 30, 60, 120, 240].map(getStreakTier);
    expect(tiers).toStrictEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
