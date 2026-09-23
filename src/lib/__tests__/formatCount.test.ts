import { describe, it, expect } from "vitest";
import { formatCompactCount, formatCountExact } from "../formatCount";

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

describe("formatCountExact", () => {
  it("groups thousands", () => {
    expect(formatCountExact(23_645)).toBe("23,645");
    expect(formatCountExact(7)).toBe("7");
  });
});
