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
  (): Promise<GitHubTokenHealthPayload> => Promise.resolve({ status: "unknown" })
);

vi.mock("@/clients/githubClient", () => ({
  githubClient: {
    onTokenHealthChanged: (cb: (payload: GitHubTokenHealthPayload) => void) =>
      onTokenHealthChangedMock(cb),
    getTokenHealth: () => getTokenHealthMock(),
  },
}));

import { useGitHubTokenHealth } from "../useGitHubTokenHealth";
import { useGitHubTokenHealthStore } from "@/store/githubTokenHealthStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";

describe("useGitHubTokenHealth", () => {
  beforeEach(() => {
    healthListener = null;
    onTokenHealthChangedMock.mockClear();
    cleanupMock.mockClear();
    getTokenHealthMock.mockReset().mockResolvedValue({ status: "unknown" });
    useGitHubTokenHealthStore.setState({ isUnhealthy: false });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
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
      healthListener?.({ status: "unhealthy" });
    });

    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(true);
  });

  it("clears the store when state returns to healthy", async () => {
    renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    act(() => healthListener?.({ status: "unhealthy" }));
    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(true);

    act(() => healthListener?.({ status: "healthy" }));
    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(false);
  });

  it("adds an inbox entry exactly once per unhealthy transition", async () => {
    renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    act(() => healthListener?.({ status: "unhealthy" }));
    act(() => healthListener?.({ status: "unhealthy" }));

    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries.filter((e) => e.correlationId === "github-token-health")).toHaveLength(1);
  });

  it("re-arms the inbox entry after recovery + a new failure", async () => {
    renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    act(() => healthListener?.({ status: "unhealthy" }));
    act(() => healthListener?.({ status: "healthy" }));
    act(() => healthListener?.({ status: "unhealthy" }));

    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries.filter((e) => e.correlationId === "github-token-health")).toHaveLength(2);
  });

  it("replays initial state on mount via getTokenHealth", async () => {
    getTokenHealthMock.mockResolvedValueOnce({ status: "unhealthy" });
    renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(true);
  });

  it("ignores payloads delivered after unmount", async () => {
    const { unmount } = renderHook(() => useGitHubTokenHealth());
    await act(async () => {});

    unmount();
    act(() => healthListener?.({ status: "unhealthy" }));

    // The store should remain false because the cancelled flag short-circuits apply().
    // (Note: cleanup() is called too, but our mock retains the listener reference for testing.)
    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(false);
  });
});
