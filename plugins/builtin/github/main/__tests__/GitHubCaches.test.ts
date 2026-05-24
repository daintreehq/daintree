import { beforeEach, describe, expect, it } from "vitest";
import {
  prETagCache,
  branchListETagCache,
  repoPRListETagCache,
  getETagCacheVersion,
  clearGitHubCaches,
  clearPRCaches,
  velocityCache,
  repoActivityProbeCache,
  repoStatsAndPageSnapshotCache,
} from "../GitHubCaches.js";

describe("GitHubCaches ETag caches", () => {
  beforeEach(() => {
    prETagCache.clear();
    branchListETagCache.clear();
    repoPRListETagCache.clear();
  });

  it("are Cache instances, not plain Maps", () => {
    expect(prETagCache.get).toBeInstanceOf(Function);
    expect(prETagCache.set).toBeInstanceOf(Function);
    expect(prETagCache.invalidate).toBeInstanceOf(Function);
    expect(typeof (prETagCache as unknown as { delete?: unknown }).delete).toBe("undefined");

    expect(branchListETagCache.get).toBeInstanceOf(Function);
    expect(branchListETagCache.set).toBeInstanceOf(Function);
    expect(branchListETagCache.invalidate).toBeInstanceOf(Function);

    expect(repoPRListETagCache.get).toBeInstanceOf(Function);
    expect(repoPRListETagCache.set).toBeInstanceOf(Function);
    expect(repoPRListETagCache.invalidate).toBeInstanceOf(Function);
  });

  it("set and get work for all caches", () => {
    prETagCache.set("owner/repo#42", '"abc123"');
    expect(prETagCache.get("owner/repo#42")).toBe('"abc123"');

    branchListETagCache.set("owner/repo@main", '"def456"');
    expect(branchListETagCache.get("owner/repo@main")).toBe('"def456"');

    repoPRListETagCache.set("owner/repo", 'W/"ghi789"');
    expect(repoPRListETagCache.get("owner/repo")).toBe('W/"ghi789"');
  });

  it("invalidate removes entries", () => {
    prETagCache.set("owner/repo#42", '"abc123"');
    prETagCache.invalidate("owner/repo#42");
    expect(prETagCache.get("owner/repo#42")).toBeUndefined();
  });

  it("TTL expires entries", async () => {
    const tinyCache = new (Object.getPrototypeOf(prETagCache).constructor)({
      maxSize: 10,
      defaultTTL: 10,
    }) as typeof prETagCache;
    tinyCache.set("k", "v");
    expect(tinyCache.get("k")).toBe("v");
    await new Promise((r) => setTimeout(r, 20));
    expect(tinyCache.get("k")).toBeUndefined();
  });
});

describe("clearGitHubCaches / clearPRCaches symmetry", () => {
  beforeEach(() => {
    prETagCache.clear();
    branchListETagCache.clear();
    repoPRListETagCache.clear();
  });

  it("clearGitHubCaches clears all ETag caches", () => {
    prETagCache.set("k1", '"v1"');
    branchListETagCache.set("k2", '"v2"');
    repoPRListETagCache.set("k3", 'W/"v3"');
    clearGitHubCaches();
    expect(prETagCache.get("k1")).toBeUndefined();
    expect(branchListETagCache.get("k2")).toBeUndefined();
    expect(repoPRListETagCache.get("k3")).toBeUndefined();
  });

  it("clearPRCaches clears all ETag caches (previously skipped them)", () => {
    prETagCache.set("k1", '"v1"');
    branchListETagCache.set("k2", '"v2"');
    repoPRListETagCache.set("k3", 'W/"v3"');
    clearPRCaches();
    expect(prETagCache.get("k1")).toBeUndefined();
    expect(branchListETagCache.get("k2")).toBeUndefined();
    expect(repoPRListETagCache.get("k3")).toBeUndefined();
  });

  it("clearPRCaches increments ETag cache version", () => {
    const before = getETagCacheVersion();
    clearPRCaches();
    expect(getETagCacheVersion()).toBeGreaterThan(before);
  });

  it("clearGitHubCaches increments ETag cache version", () => {
    const before = getETagCacheVersion();
    clearGitHubCaches();
    expect(getETagCacheVersion()).toBeGreaterThan(before);
  });
});

describe("polling-optimization caches (issue #8757)", () => {
  beforeEach(() => {
    velocityCache.clear();
    repoActivityProbeCache.clear();
    repoStatsAndPageSnapshotCache.clear();
  });

  function seedAll(): void {
    velocityCache.set("owner/repo::velocity::2026-05-20", { 60: 1, 120: 2, 180: 3 });
    repoActivityProbeCache.set("owner/repo", {
      pushedAt: "2026-05-20T00:00:00Z",
      issueUpdatedAt: "2026-05-20T00:00:00Z",
      prUpdatedAt: "2026-05-20T00:00:00Z",
    });
    repoStatsAndPageSnapshotCache.set("owner/repo", {
      stats: { issueCount: 4, prCount: 5, lastUpdated: 1 },
      issues: { items: [], endCursor: null, hasNextPage: false, totalCount: 4 },
      prs: { items: [], endCursor: null, hasNextPage: false, totalCount: 5 },
    });
  }

  it("clearGitHubCaches clears the velocity, probe, and snapshot caches", () => {
    seedAll();
    clearGitHubCaches();
    expect(velocityCache.get("owner/repo::velocity::2026-05-20")).toBeUndefined();
    expect(repoActivityProbeCache.get("owner/repo")).toBeUndefined();
    expect(repoStatsAndPageSnapshotCache.get("owner/repo")).toBeUndefined();
  });

  it("clearPRCaches drops the probe + snapshot caches (they can serve a stale PR list)", () => {
    seedAll();
    clearPRCaches();
    expect(repoActivityProbeCache.get("owner/repo")).toBeUndefined();
    expect(repoStatsAndPageSnapshotCache.get("owner/repo")).toBeUndefined();
  });

  it("clearPRCaches keeps the velocity cache — it is repo metadata, not PR-list state", () => {
    seedAll();
    clearPRCaches();
    expect(velocityCache.get("owner/repo::velocity::2026-05-20")).toEqual({
      60: 1,
      120: 2,
      180: 3,
    });
  });
});
