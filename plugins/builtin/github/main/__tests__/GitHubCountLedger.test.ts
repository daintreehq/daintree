import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetReadStampForTests,
  clearHeldCounts,
  getHeldCount,
  holdObservedCount,
  holdRestCounts,
  issueReadStamp,
  restDisagreements,
  withHeldCounts,
} from "../GitHubCountLedger.js";

const KEY = "owner/repo";

describe("GitHubCountLedger (#16866)", () => {
  beforeEach(() => {
    clearHeldCounts();
    _resetReadStampForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stamps reads issued in the same millisecond in the order they were issued", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    const first = issueReadStamp();
    const second = issueReadStamp();
    const third = issueReadStamp();

    expect(first).toBe(1_000_000);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    // Still a time: a stamp never runs ahead of the clock by a millisecond.
    expect(third - first).toBeLessThan(1);
  });

  it("holds a same-millisecond later read over an earlier one that answers after it", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const olderRead = issueReadStamp();
    const newerRead = issueReadStamp();

    expect(holdObservedCount(KEY, "issue", 0, newerRead)).toBe(true);
    expect(holdObservedCount(KEY, "issue", 1, olderRead)).toBe(false);

    expect(getHeldCount(KEY, "issue")?.count).toBe(0);
  });

  it("keeps the stamps increasing across a clear, so a read still in flight can't outrank a later one", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    issueReadStamp();
    const inFlight = issueReadStamp();

    clearHeldCounts();
    const afterClear = issueReadStamp();
    expect(afterClear).toBeGreaterThan(inFlight);

    expect(holdObservedCount(KEY, "issue", 0, afterClear)).toBe(true);
    expect(holdObservedCount(KEY, "issue", 1, inFlight)).toBe(false);
    expect(getHeldCount(KEY, "issue")?.count).toBe(0);
  });

  it("lets a REST reading fill an unknown count and re-stamp an agreeing one, never move a held one", () => {
    holdObservedCount(KEY, "issue", 0, 1_000, 1_000);

    holdRestCounts(KEY, { issueCount: 1, prCount: 4 }, 2_000, 2_000);

    // The disagreeing issue count is GraphQL's to settle.
    expect(getHeldCount(KEY, "issue")).toMatchObject({ count: 0, refreshedAt: 1_000 });
    expect(getHeldCount(KEY, "pr")).toMatchObject({ count: 4, refreshedAt: 2_000 });
    expect(restDisagreements(KEY, { issueCount: 1, prCount: 4 })).toEqual(["issue"]);

    holdRestCounts(KEY, { issueCount: 0, prCount: 4 }, 3_000, 3_000);
    expect(getHeldCount(KEY, "issue")).toMatchObject({ count: 0, refreshedAt: 3_000 });
  });

  it("ignores a REST reading issued before the held count's read, even when it agrees", () => {
    holdObservedCount(KEY, "issue", 2, 5_000, 5_000);

    holdRestCounts(KEY, { issueCount: 2, prCount: 0 }, 4_000, 9_000);

    expect(getHeldCount(KEY, "issue")).toMatchObject({ readAt: 5_000, refreshedAt: 5_000 });
  });

  it("draws held counts over stats, keeping the later stamp only where they agree", () => {
    holdObservedCount(KEY, "issue", 0, 1_000, 4_000);
    holdObservedCount(KEY, "pr", 3, 1_000, 2_000);

    const drawn = withHeldCounts(KEY, {
      issueCount: 1,
      prCount: 3,
      lastUpdated: 9_000,
      issueCountRefreshedAt: 8_000,
      prCountRefreshedAt: 6_000,
    });

    expect(drawn).toMatchObject({
      issueCount: 0,
      issueCountRefreshedAt: 4_000,
      prCount: 3,
      prCountRefreshedAt: 6_000,
      lastUpdated: 9_000,
    });
  });

  it("leaves stats alone when nothing is held", () => {
    const stats = { issueCount: 5, prCount: 2, lastUpdated: 1 };

    expect(withHeldCounts(KEY, stats)).toBe(stats);
  });
});
