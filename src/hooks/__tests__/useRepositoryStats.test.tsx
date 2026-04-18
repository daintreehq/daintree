// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryStats } from "@/types";

const { getCurrentMock, onSwitchMock, getRepoStatsMock, onRateLimitChangedMock } = vi.hoisted(
  () => ({
    getCurrentMock: vi.fn(),
    onSwitchMock: vi.fn(),
    getRepoStatsMock: vi.fn(),
    onRateLimitChangedMock: vi.fn<(cb: (payload: unknown) => void) => () => void>(() => () => {}),
  })
);

vi.mock("@/clients", () => ({
  projectClient: {
    getCurrent: getCurrentMock,
    onSwitch: onSwitchMock,
  },
  githubClient: {
    getRepoStats: getRepoStatsMock,
    onRateLimitChanged: onRateLimitChangedMock,
  },
}));

import { useRepositoryStats } from "../useRepositoryStats";

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
