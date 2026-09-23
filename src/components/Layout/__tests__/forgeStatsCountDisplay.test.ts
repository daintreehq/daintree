import { describe, it, expect } from "vitest";
import {
  formatCompactCount,
  formatExactCount,
  formatForgeBadgeCount,
  resolveForgeDisplayCount,
} from "../forgeStatsCountDisplay";

/**
 * Recency arbitration between the stats poll and the list-derived count
 * (issue #9741). Behavioral tests on the pure resolver — no React/jsdom, so
 * none of the toolbar's dynamic-import teardown races apply.
 */
describe("resolveForgeDisplayCount", () => {
  it("falls back to the stats count before the dropdown has loaded", () => {
    expect(resolveForgeDisplayCount(7, 1000, null, false, null)).toBe(7);
  });

  it("uses the list count when there is no stats baseline yet", () => {
    // statsLastUpdated == null → no poll has resolved; a present list count is
    // the best available value regardless of its own timestamp.
    expect(resolveForgeDisplayCount(null, null, 5, false, null)).toBe(5);
    expect(resolveForgeDisplayCount(null, null, 5, false, 1000)).toBe(5);
  });

  it("prefers the list count when it is strictly newer than the stats poll", () => {
    expect(resolveForgeDisplayCount(7, 1000, 5, false, 2000)).toBe(5);
  });

  it("prefers the list count on a same-millisecond tie (>= boundary)", () => {
    // The list is the higher-fidelity source, so a tie must not drop it.
    expect(resolveForgeDisplayCount(7, 1500, 5, false, 1500)).toBe(5);
  });

  it("yields to the stats count once a later poll lands", () => {
    // The core bug: a fresher stats read must beat the older list count.
    expect(resolveForgeDisplayCount(9, 3000, 5, false, 2000)).toBe(9);
  });

  it("yields to the stats count when the list count has no timestamp but stats do", () => {
    expect(resolveForgeDisplayCount(9, 3000, 5, false, null)).toBe(9);
  });

  it("suffixes the winning list count with + only when approximate", () => {
    expect(resolveForgeDisplayCount(7, 1000, 20, true, 2000)).toBe("20+");
    expect(resolveForgeDisplayCount(7, 1000, 20, false, 2000)).toBe(20);
  });

  it("does not suffix the stats count even when the list is approximate but stale", () => {
    // The approximate flag belongs to the list source; when stats win, the
    // exact stats total is shown without a "+".
    expect(resolveForgeDisplayCount(9, 3000, 20, true, 2000)).toBe(9);
  });

  it("returns null when both sources are empty", () => {
    expect(resolveForgeDisplayCount(null, null, null, false, null)).toBeNull();
  });

  it("preserves a genuine zero from whichever source wins", () => {
    expect(resolveForgeDisplayCount(3, 3000, 0, false, 4000)).toBe(0);
    expect(resolveForgeDisplayCount(0, 3000, 5, false, 2000)).toBe(0);
  });
});

const SCALE: Record<string, number> = { "": 1, k: 1e3, M: 1e6, B: 1e9 };

/** The number a compact badge claims: `23k` → 23000. */
function claimed(badge: string): number {
  const m = /^([\d.]+)([kMB]?)$/.exec(badge);
  if (!m) throw new Error(`unparseable badge ${badge}`);
  return Number(m[1]) * (SCALE[m[2] ?? ""] ?? Number.NaN);
}

describe("formatCompactCount", () => {
  it("keeps counts under a thousand exact", () => {
    for (const n of [0, 7, 42, 999]) expect(formatCompactCount(n)).toBe(String(n));
  });

  it("never renders wider than four characters", () => {
    for (let n = 0; n < 2_000_000_000; n = Math.floor(n * 1.37) + 1) {
      expect(formatCompactCount(n).length, `${n}`).toBeLessThanOrEqual(4);
    }
  });

  it("never claims more than the real count", () => {
    for (let n = 0; n < 2_000_000_000; n = Math.floor(n * 1.29) + 1) {
      expect(claimed(formatCompactCount(n)), `${n}`).toBeLessThanOrEqual(n);
    }
  });

  it("is monotonic, so a growing count never reads smaller", () => {
    let prev = -1;
    for (let n = 0; n < 50_000_000; n = Math.floor(n * 1.11) + 1) {
      const v = claimed(formatCompactCount(n));
      expect(v, `${n}`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("drops a trailing .0 rather than printing it", () => {
    expect(formatCompactCount(1_000)).not.toMatch(/\.0/);
    expect(formatCompactCount(2_000_000)).not.toMatch(/\.0/);
  });
});

describe("formatForgeBadgeCount / formatExactCount", () => {
  it("compacts the badge and keeps the exact figure for names and tooltips", () => {
    expect(formatForgeBadgeCount(23_645)).not.toContain("23645");
    expect(formatExactCount(23_645)).toBe("23,645");
  });

  it("keeps the approximate marker on the list's N+ form", () => {
    expect(formatForgeBadgeCount("20+")).toBe("20+");
    expect(formatForgeBadgeCount("1500+")).toMatch(/\+$/);
    expect(formatExactCount("1500+")).toBe("1,500+");
  });

  it("passes null through for the em-dash placeholder", () => {
    expect(formatForgeBadgeCount(null)).toBeNull();
    expect(formatExactCount(null)).toBe("—");
  });
});
