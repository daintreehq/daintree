import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoRef } from "../../../../../shared/types/forge.js";

const { restMock, restPageMock } = vi.hoisted(() => ({
  restMock: vi.fn(),
  restPageMock: vi.fn(),
}));

vi.mock("../GitLabClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../GitLabClient.js")>()),
  gitlabRest: restMock,
  gitlabRestPage: restPageMock,
}));

import { GitLabApiError } from "../GitLabClient.js";
import {
  clearGitLabCaches,
  getIssueTooltipImpl,
  getPRTooltipImpl,
  getRepoStatsImpl,
  gitLabCacheSizesForTests,
  resolveAuthorAvatarImpl,
} from "../readOps.js";

const REPO: RepoRef = { host: "gitlab.com", owner: "group", repo: "project", rawData: null };

function issue(iid: number) {
  return { iid, title: `Issue ${iid}`, state: "opened", labels: [] };
}

function repo(name: string): RepoRef {
  return { ...REPO, repo: name };
}

beforeEach(() => {
  vi.useFakeTimers();
  restMock.mockReset();
  restPageMock.mockReset();
  clearGitLabCaches();
});

afterEach(() => {
  clearGitLabCaches();
  vi.useRealTimers();
});

describe("GitLab cache residency", () => {
  it("releases expired tooltip entries without their keys being read again", async () => {
    restMock.mockImplementation(async ({ path }: { path: string }) => ({
      data: issue(Number(path.split("/").pop())),
      headers: new Headers(),
    }));
    for (let i = 1; i <= 1_000; i++) await getIssueTooltipImpl(REPO, i);
    expect(gitLabCacheSizesForTests().issueTooltips).toBeGreaterThan(0);
    expect(gitLabCacheSizesForTests().issueTooltips).toBeLessThan(1_000);

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(gitLabCacheSizesForTests().issueTooltips).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a fresh entry through a sweep that releases older ones", async () => {
    restMock.mockImplementation(async ({ path }: { path: string }) => ({
      data: issue(Number(path.split("/").pop())),
      headers: new Headers(),
    }));
    await getIssueTooltipImpl(REPO, 1);
    await vi.advanceTimersByTimeAsync(45_000);
    await getIssueTooltipImpl(REPO, 2);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(gitLabCacheSizesForTests().issueTooltips).toBe(1);
    const calls = restMock.mock.calls.length;
    await getIssueTooltipImpl(REPO, 2);
    expect(restMock.mock.calls.length).toBe(calls);
  });

  it("caps every cache however many distinct keys are visited", async () => {
    restMock.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "/avatar") return { data: { avatar_url: null }, headers: new Headers() };
      return { data: issue(Number(path.split("/").pop())), headers: new Headers() };
    });
    restPageMock.mockResolvedValue({ items: [], nextCursor: null, hasMore: false, totalCount: 0 });
    for (let i = 1; i <= 1_500; i++) {
      await getIssueTooltipImpl(REPO, i);
      await getPRTooltipImpl(REPO, i);
      await resolveAuthorAvatarImpl("gitlab.com", `user${i}@example.com`);
    }
    for (let i = 0; i < 100; i++) await getRepoStatsImpl(repo(`r${i}`));

    const sizes = gitLabCacheSizesForTests();
    expect(sizes.issueTooltips).toBeLessThan(1_500);
    expect(sizes.prTooltips).toBeLessThan(1_500);
    expect(sizes.avatars).toBeLessThan(1_500);
    expect(sizes.repoStats).toBeLessThan(100);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps serving hits and negative entries", async () => {
    restMock.mockRejectedValue(new GitLabApiError(404, "Not Found"));
    expect(await getIssueTooltipImpl(REPO, 7)).toBeNull();
    expect(await resolveAuthorAvatarImpl("gitlab.com", "ghost@example.com")).toBeNull();
    const calls = restMock.mock.calls.length;

    expect(await getIssueTooltipImpl(REPO, 7)).toBeNull();
    expect(await resolveAuthorAvatarImpl("gitlab.com", "ghost@example.com")).toBeNull();
    expect(restMock.mock.calls.length).toBe(calls);
  });

  it("does not cache or arm a sweep for a transient avatar failure", async () => {
    restMock.mockRejectedValue(new GitLabApiError(503, "Unavailable"));
    await resolveAuthorAvatarImpl("gitlab.com", "user@example.com");
    expect(gitLabCacheSizesForTests().avatars).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clearing the caches cancels the sweep", async () => {
    restMock.mockResolvedValue({ data: issue(1), headers: new Headers() });
    await getIssueTooltipImpl(REPO, 1);
    expect(vi.getTimerCount()).toBe(1);
    clearGitLabCaches();
    expect(vi.getTimerCount()).toBe(0);
    expect(gitLabCacheSizesForTests().issueTooltips).toBe(0);
  });

  it("a read that predates an invalidation neither repopulates nor arms the sweep", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    restMock.mockImplementation(async () => {
      await gate;
      return { data: issue(1), headers: new Headers() };
    });
    const inFlight = getIssueTooltipImpl(REPO, 1);
    clearGitLabCaches();
    release();
    await inFlight;
    expect(gitLabCacheSizesForTests().issueTooltips).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("repository stats stale fallback", () => {
  function seedStats(): void {
    restPageMock.mockResolvedValue({
      items: [issue(1)],
      nextCursor: null,
      hasMore: false,
      totalCount: 1,
    });
  }

  it("serves the last snapshot as stale when a refresh after expiry fails", async () => {
    seedStats();
    await getRepoStatsImpl(REPO);
    await vi.advanceTimersByTimeAsync(60_000);
    restPageMock.mockRejectedValue(new GitLabApiError(500, "Server error"));

    const result = await getRepoStatsImpl(REPO);
    expect(result.source).toBe("memory-cache");
    expect(result.counts).toMatchObject({ issueCount: 1, stale: true });
  });

  it("stops serving the stale snapshot once its retention ends", async () => {
    seedStats();
    await getRepoStatsImpl(REPO);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(gitLabCacheSizesForTests().repoStats).toBe(0);
    restPageMock.mockRejectedValue(new GitLabApiError(500, "Server error"));

    const result = await getRepoStatsImpl(REPO, { bypassCache: true });
    expect(result.source).toBe("network");
    expect(result.counts.issueCount).toBeNull();
  });
});
