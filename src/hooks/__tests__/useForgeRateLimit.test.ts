// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ForgeRateLimitChangedPayload } from "@shared/types/ipc/forge";
import type { RateLimitDetails, RateLimitInfo } from "@shared/types/forge";

const PROVIDER_ID = "daintree.github.github";
const OTHER_PROVIDER_ID = "acme.gitlab.gitlab";

let rateLimitListener: ((payload: ForgeRateLimitChangedPayload) => void) | null = null;
const cleanupMock = vi.fn();
const onRateLimitChangedMock = vi.fn(
  (callback: (payload: ForgeRateLimitChangedPayload) => void): (() => void) => {
    rateLimitListener = callback;
    return cleanupMock;
  }
);
const getRateLimitDetailsMock = vi.fn((_cwd: string): Promise<RateLimitDetails | null> =>
  Promise.resolve(null)
);

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    onRateLimitChanged: (cb: (payload: ForgeRateLimitChangedPayload) => void) =>
      onRateLimitChangedMock(cb),
    getRateLimitDetails: (cwd: string) => getRateLimitDetailsMock(cwd),
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string; path: string } }) => unknown) =>
    selector({ currentProject: { id: "proj-1", path: "/repo" } }),
}));

const resolvedProviderRef = vi.hoisted(() => ({
  providerId: "daintree.github.github" as string | null,
}));
vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: () => ({
    entry: null,
    providerId: resolvedProviderRef.providerId,
    resolvedVia: null,
    loading: false,
    refresh: () => {},
  }),
}));

import { useForgeRateLimit } from "../useForgeRateLimit";
import {
  useForgeProviderHealthStore,
  DEFAULT_PROVIDER_HEALTH,
} from "@/store/forgeProviderHealthStore";

function slice(providerId: string) {
  return useForgeProviderHealthStore.getState().providers[providerId] ?? DEFAULT_PROVIDER_HEALTH;
}

function info(overrides: Partial<RateLimitInfo>): RateLimitInfo {
  return { limit: 5000, remaining: 4500, resetAt: null, ...overrides };
}

function makeDetails(buckets: Array<{ remaining: number; resetAt: number }>): RateLimitDetails {
  return {
    buckets: buckets.map((b, i) => ({
      name: `bucket-${i}`,
      limit: 5000,
      used: 5000 - b.remaining,
      remaining: b.remaining,
      resetAt: b.resetAt,
    })),
    fetchedAt: Date.now(),
  };
}

describe("useForgeRateLimit", () => {
  beforeEach(() => {
    rateLimitListener = null;
    onRateLimitChangedMock.mockClear();
    cleanupMock.mockClear();
    getRateLimitDetailsMock.mockReset().mockResolvedValue(null);
    resolvedProviderRef.providerId = PROVIDER_ID;
    useForgeProviderHealthStore.setState({ providers: {} });
  });

  it("subscribes on mount and cleans up on unmount", () => {
    const { unmount } = renderHook(() => useForgeRateLimit());
    expect(onRateLimitChangedMock).toHaveBeenCalledOnce();
    unmount();
    expect(cleanupMock).toHaveBeenCalledOnce();
  });

  it("flips the provider's slice to blocked on a spent-budget push", async () => {
    renderHook(() => useForgeRateLimit());
    await act(async () => {});

    const resetAt = Date.now() + 60_000;
    act(() =>
      rateLimitListener?.({ providerId: PROVIDER_ID, state: info({ remaining: 0, resetAt }) })
    );

    const state = slice(PROVIDER_ID);
    expect(state.rateLimitBlocked).toBe(true);
    expect(state.rateLimitKind).toBe("primary");
    expect(state.rateLimitResetAt).toBe(resetAt);
  });

  it("marks a secondary throttle as a secondary block even with budget remaining", async () => {
    renderHook(() => useForgeRateLimit());
    await act(async () => {});

    act(() =>
      rateLimitListener?.({
        providerId: PROVIDER_ID,
        state: info({ remaining: 4000, secondaryThrottled: true }),
      })
    );

    expect(slice(PROVIDER_ID).rateLimitBlocked).toBe(true);
    expect(slice(PROVIDER_ID).rateLimitKind).toBe("secondary");
  });

  it("clears the slice when the block clears", async () => {
    renderHook(() => useForgeRateLimit());
    await act(async () => {});

    act(() => rateLimitListener?.({ providerId: PROVIDER_ID, state: info({ remaining: 0 }) }));
    expect(slice(PROVIDER_ID).rateLimitBlocked).toBe(true);

    act(() => rateLimitListener?.({ providerId: PROVIDER_ID, state: info({ remaining: 100 }) }));
    expect(slice(PROVIDER_ID).rateLimitBlocked).toBe(false);
    expect(slice(PROVIDER_ID).rateLimitKind).toBeNull();
    expect(slice(PROVIDER_ID).rateLimitResetAt).toBeNull();
  });

  it("keys pushes by payload providerId so providers never cross-contaminate", async () => {
    renderHook(() => useForgeRateLimit());
    await act(async () => {});

    act(() =>
      rateLimitListener?.({ providerId: OTHER_PROVIDER_ID, state: info({ remaining: 0 }) })
    );

    expect(slice(OTHER_PROVIDER_ID).rateLimitBlocked).toBe(true);
    expect(slice(PROVIDER_ID).rateLimitBlocked).toBe(false);
  });

  it("forwards throttleMultiplier from the push state", async () => {
    renderHook(() => useForgeRateLimit());
    await act(async () => {});

    act(() =>
      rateLimitListener?.({
        providerId: PROVIDER_ID,
        state: info({ remaining: 200, throttleMultiplier: 7 }),
      })
    );

    expect(slice(PROVIDER_ID).rateLimitMultiplier).toBe(7);
    expect(slice(PROVIDER_ID).rateLimitBlocked).toBe(false);
  });

  it("hydrates from the detail snapshot when a bucket is exhausted on mount", async () => {
    const futureResetAt = Date.now() + 30_000;
    getRateLimitDetailsMock.mockResolvedValueOnce(
      makeDetails([
        { remaining: 4500, resetAt: futureResetAt },
        { remaining: 0, resetAt: futureResetAt },
      ])
    );

    renderHook(() => useForgeRateLimit());
    await act(async () => {});

    expect(getRateLimitDetailsMock).toHaveBeenCalledWith("/repo");
    const state = slice(PROVIDER_ID);
    expect(state.rateLimitBlocked).toBe(true);
    expect(state.rateLimitKind).toBe("primary");
    expect(state.rateLimitResetAt).toBe(futureResetAt);
  });

  it("does not hydrate as blocked when every bucket has quota remaining", async () => {
    getRateLimitDetailsMock.mockResolvedValueOnce(
      makeDetails([{ remaining: 4500, resetAt: Date.now() + 3_600_000 }])
    );

    renderHook(() => useForgeRateLimit());
    await act(async () => {});

    expect(slice(PROVIDER_ID).rateLimitBlocked).toBe(false);
  });

  it("ignores an exhausted bucket whose reset is already in the past", async () => {
    getRateLimitDetailsMock.mockResolvedValueOnce(
      makeDetails([{ remaining: 0, resetAt: Date.now() - 1_000 }])
    );

    renderHook(() => useForgeRateLimit());
    await act(async () => {});

    expect(slice(PROVIDER_ID).rateLimitBlocked).toBe(false);
  });

  it("skips the replay while no provider resolves for the active project", async () => {
    resolvedProviderRef.providerId = null;
    renderHook(() => useForgeRateLimit());
    await act(async () => {});

    expect(getRateLimitDetailsMock).not.toHaveBeenCalled();
    // The push subscription stays live so a re-enable flows through.
    expect(onRateLimitChangedMock).toHaveBeenCalledOnce();
  });

  it("ignores a stale replay after a live push has already landed", async () => {
    const futureResetAt = Date.now() + 30_000;
    let resolveReplay!: (details: RateLimitDetails | null) => void;
    getRateLimitDetailsMock.mockImplementationOnce(
      () =>
        new Promise<RateLimitDetails | null>((resolve) => {
          resolveReplay = resolve;
        })
    );

    renderHook(() => useForgeRateLimit());
    await act(async () => {});

    act(() =>
      rateLimitListener?.({
        providerId: PROVIDER_ID,
        state: info({ remaining: 0, resetAt: futureResetAt }),
      })
    );
    expect(slice(PROVIDER_ID).rateLimitBlocked).toBe(true);

    // Replay resolves later with stale "unblocked" data — must not overwrite.
    await act(async () => {
      resolveReplay(makeDetails([{ remaining: 4500, resetAt: futureResetAt }]));
    });
    expect(slice(PROVIDER_ID).rateLimitBlocked).toBe(true);
  });

  it("ignores payloads delivered after unmount", async () => {
    const { unmount } = renderHook(() => useForgeRateLimit());
    await act(async () => {});
    unmount();

    act(() =>
      rateLimitListener?.({
        providerId: PROVIDER_ID,
        state: info({ remaining: 0, resetAt: 1_700_000_000_000 }),
      })
    );
    expect(slice(PROVIDER_ID).rateLimitBlocked).toBe(false);
  });
});
