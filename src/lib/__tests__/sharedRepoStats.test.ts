// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  publishSharedRepoStats,
  readSharedRepoStats,
  subscribeSharedRepoStats,
  type SharedRepoReading,
} from "../sharedRepoStats";

const REPO = "github.com/acme/widgets";
const NOW = 1_700_000_000_000;

function reading(hostId: string, lastUpdated: number, issueCount = 3): SharedRepoReading {
  return {
    issueCount,
    prCount: 1,
    lastUpdated,
    issueRefreshedAt: lastUpdated,
    prRefreshedAt: lastUpdated,
    hostId,
  };
}

describe("sharedRepoStats", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("reads the reading this Shell received last, from any host", () => {
    publishSharedRepoStats(REPO, reading("studio", 2_000, 5), NOW);
    publishSharedRepoStats(REPO, reading("build-box", 3_000, 8), NOW + 10);
    publishSharedRepoStats(REPO, reading("local", 1_000, 1), NOW + 20);

    expect(readSharedRepoStats(REPO)).toMatchObject({ hostId: "local", issueCount: 1 });
  });

  it("orders hosts by receipt, not by their own clocks", () => {
    // build-box's clock runs a day ahead of studio's.
    publishSharedRepoStats(REPO, reading("build-box", NOW + 86_000_000, 8), NOW);
    publishSharedRepoStats(REPO, reading("studio", NOW + 10, 5), NOW + 10);

    expect(readSharedRepoStats(REPO)?.issueCount).toBe(5);
  });

  it("picks the same entry on a tie, whichever was written first", () => {
    publishSharedRepoStats(REPO, reading("studio", 2_000, 5), NOW);
    publishSharedRepoStats(REPO, reading("build-box", 3_000, 8), NOW);
    const first = readSharedRepoStats(REPO)?.hostId;

    window.localStorage.clear();
    publishSharedRepoStats(REPO, reading("build-box", 3_000, 8), NOW);
    publishSharedRepoStats(REPO, reading("studio", 2_000, 5), NOW);

    expect(readSharedRepoStats(REPO)?.hostId).toBe(first);
  });

  it("never lets a host republish a reading, or replace it with an older one", () => {
    expect(publishSharedRepoStats(REPO, reading("studio", 2_000, 5), NOW)).toBe(true);
    publishSharedRepoStats(REPO, reading("local", 2_500, 9), NOW + 10);

    expect(publishSharedRepoStats(REPO, reading("studio", 2_000, 5), NOW + 20)).toBe(false);
    expect(publishSharedRepoStats(REPO, reading("studio", 1_000, 4), NOW + 30)).toBe(false);
    expect(readSharedRepoStats(REPO)?.hostId).toBe("local");

    expect(publishSharedRepoStats(REPO, reading("studio", 3_000, 0), NOW + 40)).toBe(true);
    expect(readSharedRepoStats(REPO)).toMatchObject({ hostId: "studio", issueCount: 0 });
  });

  it("takes a host's readings again once its clock is corrected back", () => {
    // studio's clock ran an hour ahead when it published.
    publishSharedRepoStats(REPO, reading("studio", NOW + 3_600_000, 5), NOW);

    expect(publishSharedRepoStats(REPO, reading("studio", NOW + 60_000, 6), NOW + 60_000)).toBe(
      false
    );
    expect(publishSharedRepoStats(REPO, reading("studio", NOW + 400_000, 7), NOW + 400_000)).toBe(
      true
    );
    expect(readSharedRepoStats(REPO)?.issueCount).toBe(7);
  });

  describe("cache replays", () => {
    it("dates one by when the host made it, through the host's clock offset", () => {
      // studio's clock runs 10s behind this Shell's.
      publishSharedRepoStats(REPO, reading("studio", NOW - 10_000, 5), NOW);
      publishSharedRepoStats(REPO, reading("local", NOW + 20_000, 8), NOW + 20_000);

      // Made at studio's NOW + 5s (this Shell's NOW + 15s): older than local's.
      expect(
        publishSharedRepoStats(
          REPO,
          { ...reading("studio", NOW + 5_000, 4), replay: true },
          NOW + 30_000
        )
      ).toBe(true);
      expect(readSharedRepoStats(REPO)?.hostId).toBe("local");

      // Made after local's reading, so it is the newest.
      publishSharedRepoStats(
        REPO,
        { ...reading("studio", NOW + 15_000, 3), replay: true },
        NOW + 40_000
      );
      expect(readSharedRepoStats(REPO)).toMatchObject({
        hostId: "studio",
        issueCount: 3,
        receivedAt: NOW + 25_000,
      });
    });

    it("only fills an empty record from a host this Shell has no entry from", () => {
      expect(
        publishSharedRepoStats(REPO, { ...reading("studio", 2_000, 5), replay: true }, NOW)
      ).toBe(true);
      expect(readSharedRepoStats(REPO)?.hostId).toBe("studio");

      expect(
        publishSharedRepoStats(REPO, { ...reading("build-box", 9_000, 8), replay: true }, NOW + 10)
      ).toBe(false);
      expect(readSharedRepoStats(REPO)?.hostId).toBe("studio");
    });
  });

  it("dates each count on this Shell's clock by the age the host reported", () => {
    publishSharedRepoStats(
      REPO,
      { ...reading("studio", 50_000), issueRefreshedAt: 20_000, prRefreshedAt: 49_000 },
      NOW
    );

    expect(readSharedRepoStats(REPO)).toMatchObject({
      receivedAt: NOW,
      issueObservedAt: NOW - 30_000,
      prObservedAt: NOW - 1_000,
      sourceUpdatedAt: 50_000,
    });
  });

  it("keeps origins apart, whatever provider or account reported them", () => {
    publishSharedRepoStats(REPO, reading("studio", 1_000), NOW);

    expect(readSharedRepoStats(`${REPO}-2`)).toBeNull();
    expect(readSharedRepoStats("github.com/acme")).toBeNull();
    expect(readSharedRepoStats(REPO)?.hostId).toBe("studio");
  });

  it.each([
    ["unparseable JSON", "{not json"],
    ["a negative count", { issueCount: -1 }],
    ["a fractional count", { prCount: 1.5 }],
    ["a far-future receipt", { receivedAt: Date.now() + 10 * 24 * 60 * 60 * 1000 }],
    ["a missing host", { hostId: undefined }],
  ])("reads an entry with %s as absent", (_label, change) => {
    publishSharedRepoStats(REPO, reading("studio", 1_000), NOW);
    const key = Object.keys(window.localStorage).find((k) => k.includes("repo-stats"))!;
    const stored =
      typeof change === "string"
        ? change
        : JSON.stringify({ ...JSON.parse(window.localStorage.getItem(key)!), ...change });
    window.localStorage.setItem(key, stored);

    expect(readSharedRepoStats(REPO)).toBeNull();
  });

  it("refuses to publish an invalid reading", () => {
    publishSharedRepoStats(REPO, reading("studio", 1_000), NOW);

    expect(
      publishSharedRepoStats(REPO, { ...reading("studio", 2_000), issueCount: Number.NaN }, NOW)
    ).toBe(false);
    expect(readSharedRepoStats(REPO)?.sourceUpdatedAt).toBe(1_000);
  });

  it("treats blocked storage as empty instead of throwing", () => {
    publishSharedRepoStats(REPO, reading("studio", 1_000), NOW);
    // Spying on a Storage instance's methods just stores a key by that name, so
    // block the accessor itself, as a sandboxed or disabled store does.
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(publishSharedRepoStats(REPO, reading("x", 2_000), NOW)).toBe(false);
    expect(readSharedRepoStats(REPO)).toBeNull();
  });

  it("survives a full store", () => {
    const setItem = vi.fn(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const full: Storage = {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem,
      removeItem: () => {},
      clear: () => {},
    };
    vi.spyOn(window, "localStorage", "get").mockReturnValue(full);
    const listener = vi.fn();
    const unsubscribe = subscribeSharedRepoStats(REPO, listener);

    expect(publishSharedRepoStats(REPO, reading("x", 1_000), NOW)).toBe(false);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  describe("subscribeSharedRepoStats", () => {
    it("hears this document's publishes and other documents' storage events for the origin", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeSharedRepoStats(REPO, listener);

      publishSharedRepoStats(REPO, reading("studio", 1_000), NOW);
      expect(listener).toHaveBeenCalledTimes(1);

      const key = Object.keys(window.localStorage)[0]!;
      window.dispatchEvent(new StorageEvent("storage", { key }));
      expect(listener).toHaveBeenCalledTimes(2);

      // The whole store cleared.
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
      expect(listener).toHaveBeenCalledTimes(3);

      unsubscribe();
      publishSharedRepoStats(REPO, reading("studio", 2_000), NOW);
      window.dispatchEvent(new StorageEvent("storage", { key }));
      expect(listener).toHaveBeenCalledTimes(3);
    });

    it("ignores other origins and other keys", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeSharedRepoStats(REPO, listener);

      publishSharedRepoStats(`${REPO}-2`, reading("studio", 1_000), NOW);
      const otherKey = Object.keys(window.localStorage)[0]!;
      window.dispatchEvent(new StorageEvent("storage", { key: otherKey }));
      window.dispatchEvent(new StorageEvent("storage", { key: "daintree:unrelated" }));
      // A refused publish changes nothing.
      publishSharedRepoStats(REPO, reading("studio", 1_000), NOW);
      publishSharedRepoStats(REPO, reading("studio", 1_000), NOW);

      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
    });
  });
});
