import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { GitHubIssue, GitHubPR } from "../../../shared/types/github.js";

const STALE_MS = 11 * 60 * 1000;

function buildIssue(n: number): GitHubIssue {
  return {
    number: n,
    title: `issue ${n}`,
    url: `https://github.com/o/r/issues/${n}`,
    state: "OPEN",
    updatedAt: "2025-02-01T12:00:00.000Z",
    author: { login: "octocat", avatarUrl: "https://example.com/a.png" },
    assignees: [],
    commentCount: 0,
  };
}

function buildPR(n: number): GitHubPR {
  return {
    number: n,
    title: `pr ${n}`,
    url: `https://github.com/o/r/pull/${n}`,
    state: "OPEN",
    isDraft: false,
    updatedAt: "2025-02-01T12:00:00.000Z",
    author: { login: "octocat", avatarUrl: "https://example.com/a.png" },
  };
}

describe("GitHubFirstPageCache", () => {
  let userDataDir: string;
  let cacheFilePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-02-01T12:00:00.000Z"));
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-gh-first-page-cache-"));
    cacheFilePath = path.join(userDataDir, "github-first-page-cache.json");
    process.env.DAINTREE_USER_DATA = userDataDir;
  });

  afterEach(async () => {
    const { GitHubFirstPageCache } = await import("../GitHubFirstPageCache.js");
    GitHubFirstPageCache.resetInstance();
    const { resetWritesSuppressedForTesting } = await import("../diskPressureState.js");
    resetWritesSuppressedForTesting();
    delete process.env.DAINTREE_USER_DATA;
    vi.useRealTimers();
    vi.resetModules();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("round-trips persisted first page through disk cache", async () => {
    const { GitHubFirstPageCache } = await import("../GitHubFirstPageCache.js");
    GitHubFirstPageCache.resetInstance();
    const cache = GitHubFirstPageCache.getInstance();

    const issues = [buildIssue(1), buildIssue(2)];
    const prs = [buildPR(10)];
    cache.set(
      "octocat/hello-world",
      {
        issues: { items: issues, endCursor: "cursor-i", hasNextPage: true },
        prs: { items: prs, endCursor: null, hasNextPage: false },
      },
      "/repo/hello-world"
    );

    const result = cache.get("octocat/hello-world");
    expect(result).not.toBeNull();
    expect(result?.issues.items).toHaveLength(2);
    expect(result?.issues.endCursor).toBe("cursor-i");
    expect(result?.issues.hasNextPage).toBe(true);
    expect(result?.prs.items).toHaveLength(1);
    expect(result?.prs.hasNextPage).toBe(false);
    expect(result?.lastUpdated).toBe(Date.now());
    expect(result?.projectPath).toBe("/repo/hello-world");

    expect(fs.existsSync(cacheFilePath)).toBe(true);
  });

  it("returns null for stale entries", async () => {
    fs.writeFileSync(
      cacheFilePath,
      JSON.stringify(
        {
          version: 1,
          projects: {
            "o/r": {
              issues: { items: [buildIssue(1)], endCursor: null, hasNextPage: false },
              prs: { items: [], endCursor: null, hasNextPage: false },
              lastUpdated: Date.now() - STALE_MS,
              projectPath: "/repo",
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const { GitHubFirstPageCache } = await import("../GitHubFirstPageCache.js");
    GitHubFirstPageCache.resetInstance();
    const cache = GitHubFirstPageCache.getInstance();

    expect(cache.get("o/r")).toBeNull();
  });

  it("returns null for malformed entries", async () => {
    fs.writeFileSync(
      cacheFilePath,
      JSON.stringify(
        {
          version: 1,
          projects: {
            "o/r": {
              issues: { items: "not-an-array", endCursor: null, hasNextPage: false },
              prs: { items: [], endCursor: null, hasNextPage: false },
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

    const { GitHubFirstPageCache } = await import("../GitHubFirstPageCache.js");
    GitHubFirstPageCache.resetInstance();
    const cache = GitHubFirstPageCache.getInstance();

    expect(cache.get("o/r")).toBeNull();
  });

  it("rejects pages containing items missing render-required fields", async () => {
    // One issue is missing `author`, which `GitHubListItem` reads
    // unconditionally — accepting it would crash the dropdown on render.
    const goodIssue = buildIssue(1);
    const brokenIssue = { ...buildIssue(2), author: undefined };

    fs.writeFileSync(
      cacheFilePath,
      JSON.stringify(
        {
          version: 1,
          projects: {
            "o/r": {
              issues: { items: [goodIssue, brokenIssue], endCursor: null, hasNextPage: false },
              prs: { items: [buildPR(1)], endCursor: null, hasNextPage: false },
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

    const { GitHubFirstPageCache } = await import("../GitHubFirstPageCache.js");
    GitHubFirstPageCache.resetInstance();
    const cache = GitHubFirstPageCache.getInstance();

    expect(cache.get("o/r")).toBeNull();
  });

  it("rejects pages containing PRs missing isDraft", async () => {
    const goodPR = buildPR(1);
    const brokenPR = { ...buildPR(2), isDraft: undefined };

    fs.writeFileSync(
      cacheFilePath,
      JSON.stringify(
        {
          version: 1,
          projects: {
            "o/r": {
              issues: { items: [buildIssue(1)], endCursor: null, hasNextPage: false },
              prs: { items: [goodPR, brokenPR], endCursor: null, hasNextPage: false },
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

    const { GitHubFirstPageCache } = await import("../GitHubFirstPageCache.js");
    GitHubFirstPageCache.resetInstance();
    const cache = GitHubFirstPageCache.getInstance();

    expect(cache.get("o/r")).toBeNull();
  });

  it("evicts to keep only the latest 10 projects", async () => {
    const { GitHubFirstPageCache } = await import("../GitHubFirstPageCache.js");
    GitHubFirstPageCache.resetInstance();
    const cache = GitHubFirstPageCache.getInstance();

    for (let i = 0; i < 12; i++) {
      cache.set(
        `octocat/repo-${i}`,
        {
          issues: { items: [buildIssue(i)], endCursor: null, hasNextPage: false },
          prs: { items: [], endCursor: null, hasNextPage: false },
        },
        `/repo-${i}`
      );
      vi.advanceTimersByTime(1);
    }

    expect(cache.get("octocat/repo-0")).toBeNull();
    expect(cache.get("octocat/repo-1")).toBeNull();
    expect(cache.get("octocat/repo-11")).not.toBeNull();

    const disk = JSON.parse(fs.readFileSync(cacheFilePath, "utf8")) as {
      projects: Record<string, unknown>;
    };
    expect(Object.keys(disk.projects)).toHaveLength(10);
  });

  it("does not write to disk when disk pressure suppresses writes", async () => {
    const { GitHubFirstPageCache } = await import("../GitHubFirstPageCache.js");
    const { setWritesSuppressed } = await import("../diskPressureState.js");
    GitHubFirstPageCache.resetInstance();
    const cache = GitHubFirstPageCache.getInstance();

    setWritesSuppressed(true);
    cache.set(
      "octocat/under-pressure",
      {
        issues: { items: [buildIssue(1)], endCursor: null, hasNextPage: false },
        prs: { items: [], endCursor: null, hasNextPage: false },
      },
      "/repo/under-pressure"
    );

    expect(fs.existsSync(cacheFilePath)).toBe(false);
    // Memory cache stays consistent so in-process reads still work.
    expect(cache.get("octocat/under-pressure")).not.toBeNull();
  });

  it("clear removes cached data from memory and disk", async () => {
    const { GitHubFirstPageCache } = await import("../GitHubFirstPageCache.js");
    GitHubFirstPageCache.resetInstance();
    const cache = GitHubFirstPageCache.getInstance();

    cache.set(
      "octocat/repo",
      {
        issues: { items: [buildIssue(1)], endCursor: null, hasNextPage: false },
        prs: { items: [], endCursor: null, hasNextPage: false },
      },
      "/repo"
    );
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
