// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryStats } from "@/types";

const { getCurrentMock, onSwitchMock, getRepoStatsMock } = vi.hoisted(() => ({
  getCurrentMock: vi.fn(),
  onSwitchMock: vi.fn(),
  getRepoStatsMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  projectClient: {
    getCurrent: getCurrentMock,
    onSwitch: onSwitchMock,
  },
  githubClient: {
    getRepoStats: getRepoStatsMock,
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
});
