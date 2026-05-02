import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

describe("GitHubStatsCache", () => {
  let userDataDir: string;
  let cacheFilePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-02-01T12:00:00.000Z"));
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-gh-stats-cache-"));
    cacheFilePath = path.join(userDataDir, "github-stats-cache.json");
    process.env.DAINTREE_USER_DATA = userDataDir;
  });

  afterEach(async () => {
    const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
    GitHubStatsCache.resetInstance();
    const { resetWritesSuppressedForTesting } = await import("../diskPressureState.js");
    resetWritesSuppressedForTesting();
    delete process.env.DAINTREE_USER_DATA;
    vi.useRealTimers();
    vi.resetModules();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("round-trips persisted stats through disk cache", async () => {
    const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
    GitHubStatsCache.resetInstance();
    const cache = GitHubStatsCache.getInstance();

    cache.set("octocat/hello-world", { issueCount: 7, prCount: 3 }, "/repo/hello-world");

    expect(cache.get("octocat/hello-world")).toEqual({
      issueCount: 7,
      prCount: 3,
      lastUpdated: Date.now(),
      projectPath: "/repo/hello-world",
    });

    expect(fs.existsSync(cacheFilePath)).toBe(true);
  });

  it("returns null for stale cache entries", async () => {
    fs.writeFileSync(
      cacheFilePath,
      JSON.stringify(
        {
          version: 1,
          projects: {
            "octocat/repo": {
              issueCount: 1,
              prCount: 2,
              lastUpdated: Date.now() - EIGHT_DAYS_MS,
              projectPath: "/repo",
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
    GitHubStatsCache.resetInstance();
    const cache = GitHubStatsCache.getInstance();

    expect(cache.get("octocat/repo")).toBeNull();
  });

  it("returns null for future-dated cache entries", async () => {
    fs.writeFileSync(
      cacheFilePath,
      JSON.stringify(
        {
          version: 1,
          projects: {
            "octocat/repo": {
              issueCount: 1,
              prCount: 2,
              lastUpdated: Date.now() + 60_000,
              projectPath: "/repo",
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
    GitHubStatsCache.resetInstance();
    const cache = GitHubStatsCache.getInstance();

    expect(cache.get("octocat/repo")).toBeNull();
  });

  it("returns null for malformed entry payloads", async () => {
    fs.writeFileSync(
      cacheFilePath,
      JSON.stringify(
        {
          version: 1,
          projects: {
            "octocat/repo": {
              issueCount: "7",
              prCount: 2,
              lastUpdated: Date.now(),
              projectPath: "/repo",
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
    GitHubStatsCache.resetInstance();
    const cache = GitHubStatsCache.getInstance();

    expect(cache.get("octocat/repo")).toBeNull();
  });

  it("sanitizes invalid counts on set", async () => {
    const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
    GitHubStatsCache.resetInstance();
    const cache = GitHubStatsCache.getInstance();

    cache.set(
      "octocat/repo",
      {
        issueCount: Number.NaN as unknown as number,
        prCount: -10 as unknown as number,
      },
      "/repo"
    );

    expect(cache.get("octocat/repo")).toEqual({
      issueCount: 0,
      prCount: 0,
      lastUpdated: Date.now(),
      projectPath: "/repo",
    });
  });

  it("keeps only the latest 10 projects", async () => {
    const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
    GitHubStatsCache.resetInstance();
    const cache = GitHubStatsCache.getInstance();

    for (let i = 0; i < 12; i++) {
      cache.set(`octocat/repo-${i}`, { issueCount: i, prCount: i }, `/repo-${i}`);
      vi.advanceTimersByTime(1);
    }

    expect(cache.get("octocat/repo-0")).toBeNull();
    expect(cache.get("octocat/repo-1")).toBeNull();
    expect(cache.get("octocat/repo-2")).not.toBeNull();
    expect(cache.get("octocat/repo-11")).not.toBeNull();

    const disk = JSON.parse(fs.readFileSync(cacheFilePath, "utf8")) as {
      projects: Record<string, unknown>;
    };
    expect(Object.keys(disk.projects)).toHaveLength(10);
  });

  it("does not write to disk when disk pressure suppresses writes", async () => {
    const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
    const { setWritesSuppressed } = await import("../diskPressureState.js");
    GitHubStatsCache.resetInstance();
    const cache = GitHubStatsCache.getInstance();

    setWritesSuppressed(true);
    cache.set("octocat/under-pressure", { issueCount: 5, prCount: 2 }, "/repo/under-pressure");

    expect(fs.existsSync(cacheFilePath)).toBe(false);
    // Memory cache stays consistent so in-process reads still work.
    expect(cache.get("octocat/under-pressure")).toEqual({
      issueCount: 5,
      prCount: 2,
      lastUpdated: Date.now(),
      projectPath: "/repo/under-pressure",
    });
  });

  it("resumes writing to disk after pressure clears", async () => {
    const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
    const { setWritesSuppressed } = await import("../diskPressureState.js");
    GitHubStatsCache.resetInstance();
    const cache = GitHubStatsCache.getInstance();

    setWritesSuppressed(true);
    cache.set("octocat/dropped", { issueCount: 1, prCount: 1 }, "/repo/dropped");
    expect(fs.existsSync(cacheFilePath)).toBe(false);

    setWritesSuppressed(false);
    cache.set("octocat/persisted", { issueCount: 2, prCount: 3 }, "/repo/persisted");

    expect(fs.existsSync(cacheFilePath)).toBe(true);
    const disk = JSON.parse(fs.readFileSync(cacheFilePath, "utf8")) as {
      projects: Record<string, unknown>;
    };
    expect(disk.projects).toHaveProperty("octocat/persisted");
    // The earlier set's data was retained in memory, so the post-recovery write
    // includes it as well.
    expect(disk.projects).toHaveProperty("octocat/dropped");
  });

  describe("getForBootstrap", () => {
    it("returns entries 10-60 minutes old that get() rejects", async () => {
      const elevenMinutesMs = 11 * 60 * 1000;
      fs.writeFileSync(
        cacheFilePath,
        JSON.stringify(
          {
            version: 1,
            projects: {
              "octocat/repo": {
                issueCount: 5,
                prCount: 3,
                lastUpdated: Date.now() - elevenMinutesMs,
                projectPath: "/repo",
              },
            },
          },
          null,
          2
        ),
        "utf8"
      );

      const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
      GitHubStatsCache.resetInstance();
      const cache = GitHubStatsCache.getInstance();

      // get() rejects — entry is older than 10 minutes
      expect(cache.get("octocat/repo")).toBeNull();
      // getForBootstrap() accepts — entry is within 60 minutes
      expect(cache.getForBootstrap("octocat/repo")).toEqual({
        issueCount: 5,
        prCount: 3,
        lastUpdated: Date.now() - elevenMinutesMs,
        projectPath: "/repo",
      });
    });

    it("rejects entries older than 60 minutes", async () => {
      const sixtyOneMinutesMs = 61 * 60 * 1000;
      fs.writeFileSync(
        cacheFilePath,
        JSON.stringify(
          {
            version: 1,
            projects: {
              "octocat/repo": {
                issueCount: 5,
                prCount: 3,
                lastUpdated: Date.now() - sixtyOneMinutesMs,
                projectPath: "/repo",
              },
            },
          },
          null,
          2
        ),
        "utf8"
      );

      const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
      GitHubStatsCache.resetInstance();
      const cache = GitHubStatsCache.getInstance();

      expect(cache.getForBootstrap("octocat/repo")).toBeNull();
    });

    it("returns null for malformed entries (same validation as get)", async () => {
      fs.writeFileSync(
        cacheFilePath,
        JSON.stringify(
          {
            version: 1,
            projects: {
              "octocat/repo": {
                issueCount: "not-a-number",
                prCount: 2,
                lastUpdated: Date.now(),
                projectPath: "/repo",
              },
            },
          },
          null,
          2
        ),
        "utf8"
      );

      const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
      GitHubStatsCache.resetInstance();
      const cache = GitHubStatsCache.getInstance();

      expect(cache.getForBootstrap("octocat/repo")).toBeNull();
    });

    it("accepts a custom maxAgeMs", async () => {
      const twoMinutesMs = 2 * 60 * 1000;
      fs.writeFileSync(
        cacheFilePath,
        JSON.stringify(
          {
            version: 1,
            projects: {
              "octocat/repo": {
                issueCount: 5,
                prCount: 3,
                lastUpdated: Date.now() - twoMinutesMs,
                projectPath: "/repo",
              },
            },
          },
          null,
          2
        ),
        "utf8"
      );

      const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
      GitHubStatsCache.resetInstance();
      const cache = GitHubStatsCache.getInstance();

      // Custom 1-minute TTL — should reject the 2-minute-old entry.
      expect(cache.getForBootstrap("octocat/repo", 60 * 1000)).toBeNull();
      // Custom 5-minute TTL — should accept.
      expect(cache.getForBootstrap("octocat/repo", 5 * 60 * 1000)).not.toBeNull();
    });

    it("returns null for future-dated entries", async () => {
      fs.writeFileSync(
        cacheFilePath,
        JSON.stringify(
          {
            version: 1,
            projects: {
              "octocat/repo": {
                issueCount: 1,
                prCount: 2,
                lastUpdated: Date.now() + 60_000,
                projectPath: "/repo",
              },
            },
          },
          null,
          2
        ),
        "utf8"
      );

      const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
      GitHubStatsCache.resetInstance();
      const cache = GitHubStatsCache.getInstance();

      expect(cache.getForBootstrap("octocat/repo")).toBeNull();
    });
  });

  it("clear removes cached data from memory and disk", async () => {
    const { GitHubStatsCache } = await import("../GitHubStatsCache.js");
    GitHubStatsCache.resetInstance();
    const cache = GitHubStatsCache.getInstance();

    cache.set("octocat/repo", { issueCount: 2, prCount: 3 }, "/repo");
    cache.clear();

    expect(cache.get("octocat/repo")).toBeNull();
    const disk = JSON.parse(fs.readFileSync(cacheFilePath, "utf8")) as {
      version: number;
      projects: Record<string, unknown>;
    };
    expect(disk.version).toBe(1);
    expect(disk.projects).toEqual({});
  });
});
