// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { GitHubRateLimitDetails, GitHubRateLimitPayload } from "@shared/types/ipc/github";

let rateLimitListener: ((payload: GitHubRateLimitPayload) => void) | null = null;
const cleanupMock = vi.fn();
const onRateLimitChangedMock = vi.fn(
  (callback: (payload: GitHubRateLimitPayload) => void): (() => void) => {
    rateLimitListener = callback;
    return cleanupMock;
  }
);
const getRateLimitDetailsMock = vi.fn(
  (): Promise<GitHubRateLimitDetails | null> => Promise.resolve(null)
);

vi.mock("@/clients/githubClient", () => ({
  githubClient: {
    onRateLimitChanged: (cb: (payload: GitHubRateLimitPayload) => void) =>
      onRateLimitChangedMock(cb),
    getRateLimitDetails: () => getRateLimitDetailsMock(),
  },
}));

import { useGitHubRateLimit } from "../useGitHubRateLimit";
import { useGitHubRateLimitStore } from "@/store/githubRateLimitStore";

function makeBucket(remaining: number, resetAt: number) {
  return { limit: 5000, used: 5000 - remaining, remaining, resetAt };
}

function makeDetails(overrides?: Partial<GitHubRateLimitDetails>): GitHubRateLimitDetails {
  return {
    core: makeBucket(5000, 0),
    graphql: makeBucket(5000, 0),
    search: makeBucket(30, 0),
    fetchedAt: Date.now(),
    ...overrides,
  };
}

describe("useGitHubRateLimit", () => {
  beforeEach(() => {
    rateLimitListener = null;
    onRateLimitChangedMock.mockClear();
    cleanupMock.mockClear();
    getRateLimitDetailsMock.mockReset().mockResolvedValue(null);
    useGitHubRateLimitStore.setState({ blocked: false, kind: null, resetAt: null });
  });

  it("subscribes on mount and cleans up on unmount", () => {
    const { unmount } = renderHook(() => useGitHubRateLimit());
    expect(onRateLimitChangedMock).toHaveBeenCalledOnce();
    unmount();
    expect(cleanupMock).toHaveBeenCalledOnce();
  });

  it("flips the store to blocked on a primary push", async () => {
    renderHook(() => useGitHubRateLimit());
    await act(async () => {});

    const resetAt = Date.now() + 60_000;
    act(() => rateLimitListener?.({ blocked: true, kind: "primary", resetAt }));

    const state = useGitHubRateLimitStore.getState();
    expect(state.blocked).toBe(true);
    expect(state.kind).toBe("primary");
    expect(state.resetAt).toBe(resetAt);
  });

  it("clears the store when the block clears", async () => {
    renderHook(() => useGitHubRateLimit());
    await act(async () => {});

    act(() => rateLimitListener?.({ blocked: true, kind: "secondary", resetAt: 1 }));
    expect(useGitHubRateLimitStore.getState().blocked).toBe(true);

    act(() => rateLimitListener?.({ blocked: false, kind: null }));
    expect(useGitHubRateLimitStore.getState().blocked).toBe(false);
    expect(useGitHubRateLimitStore.getState().kind).toBeNull();
    expect(useGitHubRateLimitStore.getState().resetAt).toBeNull();
  });

  it("hydrates from /rate_limit when the core bucket is exhausted on mount", async () => {
    const futureResetAt = Date.now() + 30_000;
    getRateLimitDetailsMock.mockResolvedValueOnce(
      makeDetails({ core: makeBucket(0, futureResetAt) })
    );

    renderHook(() => useGitHubRateLimit());
    await act(async () => {});

    const state = useGitHubRateLimitStore.getState();
    expect(state.blocked).toBe(true);
    expect(state.kind).toBe("primary");
    expect(state.resetAt).toBe(futureResetAt);
  });

  it("does not hydrate as blocked when /rate_limit shows quota remaining", async () => {
    getRateLimitDetailsMock.mockResolvedValueOnce(
      makeDetails({ core: makeBucket(4500, Date.now() + 3_600_000) })
    );

    renderHook(() => useGitHubRateLimit());
    await act(async () => {});

    expect(useGitHubRateLimitStore.getState().blocked).toBe(false);
  });

  it("hydrates as blocked when only the graphql bucket is exhausted", async () => {
    const futureResetAt = Date.now() + 30_000;
    getRateLimitDetailsMock.mockResolvedValueOnce(
      makeDetails({ graphql: makeBucket(0, futureResetAt) })
    );

    renderHook(() => useGitHubRateLimit());
    await act(async () => {});

    const state = useGitHubRateLimitStore.getState();
    expect(state.blocked).toBe(true);
    expect(state.kind).toBe("primary");
    expect(state.resetAt).toBe(futureResetAt);
  });

  it("ignores a stale replay after a live push has already landed", async () => {
    const futureResetAt = Date.now() + 30_000;
    let resolveReplay!: (details: GitHubRateLimitDetails | null) => void;
    getRateLimitDetailsMock.mockImplementationOnce(
      () =>
        new Promise<GitHubRateLimitDetails | null>((resolve) => {
          resolveReplay = resolve;
        })
    );

    renderHook(() => useGitHubRateLimit());
    await act(async () => {});

    act(() => rateLimitListener?.({ blocked: true, kind: "primary", resetAt: futureResetAt }));
    expect(useGitHubRateLimitStore.getState().blocked).toBe(true);

    // Replay resolves later with stale "unblocked" data — must not overwrite.
    await act(async () => {
      resolveReplay(makeDetails({ core: makeBucket(4500, futureResetAt) }));
    });
    expect(useGitHubRateLimitStore.getState().blocked).toBe(true);
  });

  it("ignores payloads delivered after unmount", async () => {
    const { unmount } = renderHook(() => useGitHubRateLimit());
    await act(async () => {});
    unmount();

    act(() => rateLimitListener?.({ blocked: true, kind: "primary", resetAt: 1_700_000_000_000 }));
    expect(useGitHubRateLimitStore.getState().blocked).toBe(false);
  });
});
