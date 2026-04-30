// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryStats } from "@/types";

const {
  getCurrentMock,
  onSwitchMock,
  getRepoStatsMock,
  getFirstPageCacheMock,
  onRateLimitChangedMock,
  onRepoStatsAndPageUpdatedMock,
} = vi.hoisted(() => ({
  getCurrentMock: vi.fn(),
  onSwitchMock: vi.fn(),
  getRepoStatsMock: vi.fn(),
  getFirstPageCacheMock: vi.fn().mockResolvedValue(null),
  onRateLimitChangedMock: vi.fn<(cb: (payload: unknown) => void) => () => void>(() => () => {}),
  onRepoStatsAndPageUpdatedMock: vi.fn<(cb: (payload: unknown) => void) => () => void>(
    () => () => {}
  ),
}));

vi.mock("@/clients", () => ({
  projectClient: {
    getCurrent: getCurrentMock,
    onSwitch: onSwitchMock,
  },
  githubClient: {
    getRepoStats: getRepoStatsMock,
    getFirstPageCache: getFirstPageCacheMock,
    onRateLimitChanged: onRateLimitChangedMock,
    onRepoStatsAndPageUpdated: onRepoStatsAndPageUpdatedMock,
  },
}));

import { useRepositoryStats } from "../useRepositoryStats";
import {
  _resetForTests as resetGithubResourceCache,
  buildCacheKey,
  getCache,
  setCache,
} from "@/lib/githubResourceCache";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";

function createDeferred<T>() {
  let resolve: (value: T) => void;
  let reject: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

describe("useRepositoryStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("force-fetches when daintree:refresh-sidebar event is dispatched", async () => {
    const project = { id: "project-a", path: "/repo/a" };
    getCurrentMock.mockResolvedValue(project);
    onSwitchMock.mockReturnValue(() => {});

    const stats: RepositoryStats = {
      commitCount: 5,
      issueCount: 2,
      prCount: 1,
      loading: false,
      stale: false,
      lastUpdated: 1000,
    };
    getRepoStatsMock.mockResolvedValue(stats);

    renderHook(() => useRepositoryStats());

    await waitFor(() => {
      expect(getRepoStatsMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getRepoStatsMock).toHaveBeenCalledTimes(2);
      expect(getRepoStatsMock.mock.calls[1]?.[1]).toBe(true);
    });
  });

  describe("isTokenError", () => {
    const tokenErrorMessages = [
      "GitHub token not configured. Set it in Settings.",
      "Invalid GitHub token",
      "Token lacks required permissions",
      "SSO authorization required for this organization",
    ];

    it.each(tokenErrorMessages)("returns isTokenError=true for ghError: %s", async (errorMsg) => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 0,
        issueCount: 0,
        prCount: 0,
        loading: false,
        stale: false,
        lastUpdated: null,
        ghError: errorMsg,
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.isTokenError).toBe(true);
        expect(result.current.error).toBe(errorMsg);
      });
    });

    it("returns isTokenError=false for non-token errors", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValue({
        commitCount: 0,
        issueCount: 0,
        prCount: 0,
        loading: false,
        stale: false,
        lastUpdated: null,
        ghError: "Network timeout",
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.isTokenError).toBe(false);
        expect(result.current.error).toBe("Network timeout");
      });
    });

    it("resets isTokenError when error clears on successful fetch", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValueOnce({
        commitCount: 0,
        issueCount: 0,
        prCount: 0,
        loading: false,
        stale: false,
        lastUpdated: null,
        ghError: "GitHub token not configured. Set it in Settings.",
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.isTokenError).toBe(true);
      });

      getRepoStatsMock.mockResolvedValueOnce({
        commitCount: 5,
        issueCount: 2,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: 2000,
      });

      await act(async () => {
        await result.current.refresh({ force: true });
      });

      await waitFor(() => {
        expect(result.current.isTokenError).toBe(false);
        expect(result.current.error).toBeNull();
      });
    });

    it("clears isTokenError when daintree:refresh-sidebar triggers a successful refetch", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockResolvedValueOnce({
        commitCount: 0,
        issueCount: 0,
        prCount: 0,
        loading: false,
        stale: false,
        lastUpdated: null,
        ghError: "GitHub token not configured. Set it in Settings.",
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.isTokenError).toBe(true);
        expect(result.current.error).toBe("GitHub token not configured. Set it in Settings.");
      });

      getRepoStatsMock.mockResolvedValueOnce({
        commitCount: 5,
        issueCount: 2,
        prCount: 1,
        loading: false,
        stale: false,
        lastUpdated: 2000,
      });

      await act(async () => {
        window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(getRepoStatsMock).toHaveBeenCalledTimes(2);
        expect(getRepoStatsMock.mock.calls[1]?.[1]).toBe(true);
        expect(result.current.isTokenError).toBe(false);
        expect(result.current.error).toBeNull();
      });
    });
  });

  it("queues a refetch on project switch when an earlier fetch is still in flight", async () => {
    let currentProject = { id: "project-a", path: "/repo/a" };
    getCurrentMock.mockImplementation(async () => currentProject);

    let switchHandler: (() => void) | undefined;
    onSwitchMock.mockImplementation((callback: () => void) => {
      switchHandler = callback;
      return () => {};
    });

    const slowA = createDeferred<RepositoryStats>();
    const statsA: RepositoryStats = {
      commitCount: 10,
      issueCount: 1,
      prCount: 1,
      loading: false,
      stale: false,
      lastUpdated: 1000,
    };
    const statsB: RepositoryStats = {
      commitCount: 77,
      issueCount: 2,
      prCount: 3,
      loading: false,
      stale: false,
      lastUpdated: 2000,
    };

    getRepoStatsMock.mockImplementationOnce(() => slowA.promise).mockResolvedValueOnce(statsB);

    const { result } = renderHook(() => useRepositoryStats());

    await waitFor(() => {
      expect(getRepoStatsMock).toHaveBeenCalledTimes(1);
      expect(getRepoStatsMock.mock.calls[0]?.[0]).toBe("/repo/a");
    });

    currentProject = { id: "project-b", path: "/repo/b" };
    act(() => {
      switchHandler?.();
    });

    await act(async () => {
      slowA.resolve(statsA);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getRepoStatsMock).toHaveBeenCalledTimes(2);
      expect(getRepoStatsMock.mock.calls[1]?.[0]).toBe("/repo/b");
      expect(result.current.stats?.commitCount).toBe(77);
    });
  });

  describe("disk-cache hydration on mount", () => {
    beforeEach(() => {
      resetGithubResourceCache();
    });

    function makeIssue(n: number): GitHubIssue {
      return {
        number: n,
        title: `Issue #${n}`,
        url: `https://github.com/test/repo/issues/${n}`,
        state: "OPEN",
        updatedAt: "2026-04-30",
        author: { login: "user", avatarUrl: "" },
        assignees: [],
        commentCount: 0,
      };
    }

    function makePR(n: number): GitHubPR {
      return {
        ...makeIssue(n),
        isDraft: false,
      } as GitHubPR;
    }

    it("seeds the renderer cache from the disk-persisted first page on cold start", async () => {
      const project = { id: "p", path: "/repo/disk" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      // Stats fetch never resolves so the only cache-write path under test is
      // the disk hydration effect.
      getRepoStatsMock.mockImplementation(() => new Promise(() => {}));

      const issueItems = [makeIssue(1), makeIssue(2)];
      const prItems = [makePR(3)];
      const lastUpdated = Date.now() - 5_000;
      getFirstPageCacheMock.mockResolvedValueOnce({
        projectPath: project.path,
        lastUpdated,
        issues: { items: issueItems, endCursor: "issue-cursor", hasNextPage: true },
        prs: { items: prItems, endCursor: null, hasNextPage: false },
      });

      renderHook(() => useRepositoryStats());

      const issuesKey = buildCacheKey(project.path, "issue", "open", "created");
      const prsKey = buildCacheKey(project.path, "pr", "open", "created");

      await waitFor(() => {
        expect(getCache(issuesKey)?.items).toEqual(issueItems);
      });
      expect(getCache(issuesKey)?.endCursor).toBe("issue-cursor");
      expect(getCache(issuesKey)?.hasNextPage).toBe(true);
      expect(getCache(issuesKey)?.timestamp).toBe(lastUpdated);
      expect(getCache(prsKey)?.items).toEqual(prItems);
      expect(getCache(prsKey)?.timestamp).toBe(lastUpdated);
    });

    it("does not overwrite a fresher renderer cache entry with stale disk data", async () => {
      const project = { id: "p", path: "/repo/fresh" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockImplementation(() => new Promise(() => {}));

      const issuesKey = buildCacheKey(project.path, "issue", "open", "created");
      const freshTimestamp = Date.now();
      const fresherIssue = makeIssue(99);
      // Pre-seed an in-memory entry that's NEWER than the disk entry — this
      // simulates the broadcast push from the first poll landing before the
      // async disk read resolves.
      setCache(issuesKey, {
        items: [fresherIssue],
        endCursor: null,
        hasNextPage: false,
        timestamp: freshTimestamp,
      });

      getFirstPageCacheMock.mockResolvedValueOnce({
        projectPath: project.path,
        lastUpdated: freshTimestamp - 60_000,
        issues: {
          items: [makeIssue(1)],
          endCursor: null,
          hasNextPage: false,
        },
        prs: { items: [], endCursor: null, hasNextPage: false },
      });

      renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(getFirstPageCacheMock).toHaveBeenCalled();
      });
      // Microtask flush so the disk-cache .then() chain settles before we
      // assert the cache wasn't overwritten.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(getCache(issuesKey)?.items).toEqual([fresherIssue]);
      expect(getCache(issuesKey)?.timestamp).toBe(freshTimestamp);
    });

    it("is a no-op when the disk cache returns null (first-ever launch)", async () => {
      const project = { id: "p", path: "/repo/empty" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockImplementation(() => new Promise(() => {}));
      getFirstPageCacheMock.mockResolvedValueOnce(null);

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(getFirstPageCacheMock).toHaveBeenCalled();
      });

      const issuesKey = buildCacheKey(project.path, "issue", "open", "created");
      const prsKey = buildCacheKey(project.path, "pr", "open", "created");
      expect(getCache(issuesKey)).toBeUndefined();
      expect(getCache(prsKey)).toBeUndefined();
      // Hook stays alive without throwing.
      expect(result.current.error).toBeNull();
    });

    it("ignores a disk entry whose projectPath differs from the active project", async () => {
      const project = { id: "p", path: "/repo/active" };
      getCurrentMock.mockResolvedValue(project);
      onSwitchMock.mockReturnValue(() => {});
      getRepoStatsMock.mockImplementation(() => new Promise(() => {}));

      // Disk entry's projectPath doesn't match active project — the cache is
      // shared per-window across projects, so the path guard is the only
      // thing keeping a stale neighbouring repo's data out of the active view.
      getFirstPageCacheMock.mockResolvedValueOnce({
        projectPath: "/repo/other",
        lastUpdated: Date.now(),
        issues: { items: [makeIssue(7)], endCursor: null, hasNextPage: false },
        prs: { items: [], endCursor: null, hasNextPage: false },
      });

      renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(getFirstPageCacheMock).toHaveBeenCalled();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const issuesKey = buildCacheKey(project.path, "issue", "open", "created");
      expect(getCache(issuesKey)).toBeUndefined();
    });
  });

  describe("rate limits", () => {
    it("surfaces rateLimitResetAt and rateLimitKind from the stats payload", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      const resetAt = Date.now() + 60_000;
      getRepoStatsMock.mockResolvedValue({
        commitCount: 0,
        issueCount: 0,
        prCount: 0,
        loading: false,
        ghError: "GitHub rate limit exceeded. Resets in 1m.",
        rateLimitResetAt: resetAt,
        rateLimitKind: "primary",
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.rateLimitResetAt).toBe(resetAt);
        expect(result.current.rateLimitKind).toBe("primary");
      });
    });

    it("applies rate-limit state pushed via onRateLimitChanged and clears on unblock", async () => {
      getCurrentMock.mockResolvedValue({ id: "p", path: "/repo" });
      onSwitchMock.mockReturnValue(() => {});
      let pushHandler:
        | ((p: { blocked: boolean; kind: unknown; resetAt?: number }) => void)
        | undefined;
      onRateLimitChangedMock.mockImplementation((cb: (p: unknown) => void) => {
        pushHandler = cb as typeof pushHandler;
        return () => {};
      });
      getRepoStatsMock.mockResolvedValue({
        commitCount: 0,
        issueCount: 0,
        prCount: 0,
        loading: false,
      });

      const { result } = renderHook(() => useRepositoryStats());

      await waitFor(() => {
        expect(result.current.rateLimitResetAt).toBeNull();
      });

      const resetAt = Date.now() + 30_000;
      act(() => {
        pushHandler?.({ blocked: true, kind: "secondary", resetAt });
      });

      await waitFor(() => {
        expect(result.current.rateLimitResetAt).toBe(resetAt);
        expect(result.current.rateLimitKind).toBe("secondary");
      });

      act(() => {
        pushHandler?.({ blocked: false, kind: null });
      });

      await waitFor(() => {
        expect(result.current.rateLimitResetAt).toBeNull();
        expect(result.current.rateLimitKind).toBeNull();
      });
    });
  });
});
