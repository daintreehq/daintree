import { describe, it, expect } from "vitest";
import { resolveForgeDisplayCount } from "../forgeStatsCountDisplay";

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
