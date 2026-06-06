// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { GitHubTokenHealthPayload } from "@shared/types";

let healthListener: ((payload: GitHubTokenHealthPayload) => void) | null = null;
const cleanupMock = vi.fn();
const onTokenHealthChangedMock = vi.fn(
  (callback: (payload: GitHubTokenHealthPayload) => void): (() => void) => {
    healthListener = callback;
    return cleanupMock;
  }
);
const getTokenHealthMock = vi.fn(
  (): Promise<GitHubTokenHealthPayload> =>
    Promise.resolve({ status: "unknown", tokenVersion: 0, checkedAt: 0 })
);

vi.mock("@/clients/githubClient", () => ({
  githubClient: {
    onTokenHealthChanged: (cb: (payload: GitHubTokenHealthPayload) => void) =>
      onTokenHealthChangedMock(cb),
    getTokenHealth: () => getTokenHealthMock(),
  },
}));

import { useGitHubTokenHealth } from "../useGitHubTokenHealth";
import { notify, _resetRateLimitBuckets, _resetCoalesceMap } from "@/lib/notify";
import { useGitHubTokenHealthStore } from "@/store/githubTokenHealthStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";

describe("useGitHubTokenHealth", () => {
  beforeEach(() => {
    healthListener = null;
    onTokenHealthChangedMock.mockClear();
    cleanupMock.mockClear();
    getTokenHealthMock
      .mockReset()
      .mockResolvedValue({ status: "unknown", tokenVersion: 0, checkedAt: 0 });
    useGitHubTokenHealthStore.setState({ isUnhealthy: false });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
    // notify() runs for real here — keep toasts enabled (so a re-promotion
    // regression would actually mark `seenAsToast`) and clear cross-test
    // rate-limit / coalesce state.
    useNotificationSettingsStore.setState({ enabled: true });
    _resetRateLimitBuckets();
    _resetCoalesceMap();
  });

  it("subscribes on mount and cleans up on unmount", () => {
    const { unmount } = renderHook(() => useGitHubTokenHealth());
    expect(onTokenHealthChangedMock).toHaveBeenCalledOnce();
    unmount();
    expect(cleanupMock).toHaveBeenCalledOnce();
  });

  it("flips the store to unhealthy on transition payload", async () => {
    renderHook(() => useGitHubTokenHealth());
    await act(async () => {
      // flush initial getTokenHealth
    });

    act(() => {
      healthListener?.({ status: "unhealthy", tokenVersion: 0, checkedAt: 0 });
    });

    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(true);
  });

  it("clears the store when state returns to healthy", async () => {
    renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    act(() => healthListener?.({ status: "unhealthy", tokenVersion: 0, checkedAt: 0 }));
    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(true);

    act(() => healthListener?.({ status: "healthy", tokenVersion: 0, checkedAt: 0 }));
    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(false);
  });

  it("adds an inbox entry exactly once per unhealthy transition", async () => {
    renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    act(() => healthListener?.({ status: "unhealthy", tokenVersion: 0, checkedAt: 0 }));
    act(() => healthListener?.({ status: "unhealthy", tokenVersion: 0, checkedAt: 0 }));

    const entries = useNotificationHistoryStore.getState().entries;
    const healthEntries = entries.filter((e) => e.supersedeKey === "github.token");
    expect(healthEntries).toHaveLength(1);
  });

  it("writes an inbox-only backstop row that does not toast or count", async () => {
    renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    act(() => healthListener?.({ status: "unhealthy", tokenVersion: 0, checkedAt: 0 }));

    const entry = useNotificationHistoryStore
      .getState()
      .entries.find((e) => e.supersedeKey === "github.token");
    expect(entry?.supersedeKey).toBe("github.token");
    // Inbox-only backstop: must not surface as a toast, must not bump the badge.
    expect(entry?.seenAsToast).toBe(false);
    expect(entry?.countable).toBe(false);
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);
  });

  it("keeps a single active row when the toolbar's notify() supersedes the backstop", async () => {
    renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    act(() => healthListener?.({ status: "unhealthy", tokenVersion: 0, checkedAt: 0 }));

    // Drive the toolbar's expiry-notification path through the real notify()
    // so this exercises supersedeKey forwarding end-to-end, not a hand-rolled
    // addEntry that could mask a notify() regression.
    act(() => {
      notify({
        type: "warning",
        priority: "high",
        title: "GitHub authentication required",
        message: "Reconnect in settings.",
        correlationId: "github:token-expiry",
        supersedeKey: "github.token",
      });
    });

    const active = useNotificationHistoryStore
      .getState()
      .entries.filter((e) => e.supersedeKey === "github.token" && !e.archivedAt);
    expect(active).toHaveLength(1);
    expect(active[0]?.correlationId).toBe("github:token-expiry");
  });

  it("does not re-promote the backstop into a toast on a second expiry cycle", async () => {
    renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    // First cycle: backstop fires, then the toolbar path archives it.
    act(() => healthListener?.({ status: "unhealthy", tokenVersion: 0, checkedAt: 0 }));
    act(() => {
      notify({
        type: "warning",
        priority: "high",
        title: "GitHub authentication required",
        message: "Reconnect in settings.",
        correlationId: "github:token-expiry",
        supersedeKey: "github.token",
      });
    });
    act(() => healthListener?.({ status: "healthy", tokenVersion: 0, checkedAt: 0 }));

    // Second expiry: the backstop must stay inbox-only — no un-snooze re-toast.
    act(() => healthListener?.({ status: "unhealthy", tokenVersion: 0, checkedAt: 0 }));

    // Inspect the freshly written, still-active backstop row. (Superseded rows
    // get `seenAsToast: true` flipped on archival — that's the resolved state,
    // not a toast — so the active row is the one that reflects re-promotion.)
    const active = useNotificationHistoryStore
      .getState()
      .entries.find(
        (e) =>
          e.supersedeKey === "github.token" && e.title === "GitHub token expired" && !e.archivedAt
      );
    expect(active).toBeDefined();
    expect(active?.seenAsToast).toBe(false);
  });

  it("writes the backstop row on an unhealthy initial replay (no live push)", async () => {
    getTokenHealthMock.mockResolvedValueOnce({
      status: "unhealthy",
      tokenVersion: 0,
      checkedAt: 0,
    });
    renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    const backstops = useNotificationHistoryStore
      .getState()
      .entries.filter((e) => e.supersedeKey === "github.token");
    expect(backstops).toHaveLength(1);
    expect(backstops[0]?.countable).toBe(false);
  });

  it("re-arms the inbox entry after recovery + a new failure", async () => {
    renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    act(() => healthListener?.({ status: "unhealthy", tokenVersion: 0, checkedAt: 0 }));
    act(() => healthListener?.({ status: "healthy", tokenVersion: 0, checkedAt: 0 }));
    act(() => healthListener?.({ status: "unhealthy", tokenVersion: 0, checkedAt: 0 }));

    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries.filter((e) => e.supersedeKey === "github.token")).toHaveLength(2);
  });

  it("replays initial state on mount via getTokenHealth", async () => {
    getTokenHealthMock.mockResolvedValueOnce({
      status: "unhealthy",
      tokenVersion: 0,
      checkedAt: 0,
    });
    renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(true);
  });

  it("ignores payloads delivered after unmount", async () => {
    const { unmount } = renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    unmount();
    act(() => healthListener?.({ status: "unhealthy", tokenVersion: 0, checkedAt: 0 }));

    // The store should remain false because the cancelled flag short-circuits apply().
    // (Note: cleanup() is called too, but our mock retains the listener reference for testing.)
    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(false);
  });

  it("clears the store when payload status is unknown", async () => {
    renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    act(() => healthListener?.({ status: "unhealthy", tokenVersion: 0, checkedAt: 0 }));
    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(true);

    act(() => healthListener?.({ status: "unknown", tokenVersion: 0, checkedAt: 0 }));
    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(false);
  });

  it("ignores a stale initial-replay response when a live push has already arrived", async () => {
    let resolveReplay!: (payload: GitHubTokenHealthPayload) => void;
    getTokenHealthMock.mockImplementationOnce(
      () =>
        new Promise<GitHubTokenHealthPayload>((resolve) => {
          resolveReplay = resolve;
        })
    );

    renderHook(() => useGitHubTokenHealth());
    // Subscribe is sync; let the hook attach.
    await act(async () => {});

    // Live push lands first.
    act(() => healthListener?.({ status: "unhealthy", tokenVersion: 0, checkedAt: 0 }));
    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(true);

    // Now the slow replay resolves with stale data — must NOT overwrite the live state.
    await act(async () => {
      resolveReplay({ status: "healthy", tokenVersion: 0, checkedAt: 0 });
    });
    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(true);
  });
});
