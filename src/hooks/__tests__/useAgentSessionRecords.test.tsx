// @vitest-environment jsdom
import { renderHook, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentSessionRecords } from "../useAgentSessionRecords";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

function rec(sessionId: string): AgentSessionRecord {
  return {
    sessionId,
    agentId: "claude",
    worktreeId: null,
    title: null,
    projectId: "p1",
    savedAt: Date.now(),
  };
}

describe("useAgentSessionRecords", () => {
  let listMock: ReturnType<typeof vi.fn>;
  let onMock: ReturnType<typeof vi.fn>;
  let unsubscribeMock: ReturnType<typeof vi.fn>;
  let recordedCallback: (() => void) | undefined;

  beforeEach(() => {
    listMock = vi.fn().mockResolvedValue([rec("a")]);
    unsubscribeMock = vi.fn();
    recordedCallback = undefined;
    onMock = vi.fn((name: string, cb: () => void) => {
      if (name === "agent-session:recorded") recordedCallback = cb;
      return unsubscribeMock;
    });
    (window as unknown as { electron: unknown }).electron = {
      agentSessionHistory: { list: listMock },
      events: { on: onMock },
    };
  });

  it("fetches on enable and exposes the records", async () => {
    const { result } = renderHook(() => useAgentSessionRecords(true));
    await waitFor(() => {
      expect(result.current.hasLoaded).toBe(true);
    });
    expect(result.current.sessions.map((s) => s.sessionId)).toEqual(["a"]);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled", () => {
    renderHook(() => useAgentSessionRecords(false));
    expect(listMock).not.toHaveBeenCalled();
    expect(onMock).not.toHaveBeenCalled();
  });

  it("refetches when a session is journaled (agent-session:recorded push)", async () => {
    const { result } = renderHook(() => useAgentSessionRecords(true));
    await waitFor(() => {
      expect(result.current.hasLoaded).toBe(true);
    });

    listMock.mockResolvedValue([rec("b"), rec("a")]);
    act(() => {
      recordedCallback?.();
    });

    await waitFor(() => {
      expect(result.current.sessions.map((s) => s.sessionId)).toEqual(["b", "a"]);
    });
    // The quiet refresh never flips the loading flag once loaded.
    expect(result.current.isLoading).toBe(false);
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useAgentSessionRecords(true));
    await waitFor(() => {
      expect(onMock).toHaveBeenCalled();
    });
    unmount();
    expect(unsubscribeMock).toHaveBeenCalled();
  });

  it("unsubscribes and resets loading when disabled mid-fetch", async () => {
    // A list() that never resolves — disable must not strand isLoading.
    listMock.mockReturnValue(new Promise(() => {}));
    const { result, rerender } = renderHook(({ enabled }) => useAgentSessionRecords(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => {
      expect(result.current.isLoading).toBe(true);
    });

    rerender({ enabled: false });
    expect(unsubscribeMock).toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it("ignores a stale response resolving after a newer fetch (latest wins)", async () => {
    let resolveFirst: (v: AgentSessionRecord[]) => void = () => {};
    listMock.mockReturnValueOnce(
      new Promise<AgentSessionRecord[]>((resolve) => {
        resolveFirst = resolve;
      })
    );
    const { result } = renderHook(() => useAgentSessionRecords(true));
    await waitFor(() => {
      expect(recordedCallback).toBeDefined();
    });

    // Event-driven refetch resolves first with the fresh list…
    listMock.mockResolvedValue([rec("fresh")]);
    act(() => {
      recordedCallback?.();
    });
    await waitFor(() => {
      expect(result.current.sessions.map((s) => s.sessionId)).toEqual(["fresh"]);
    });

    // …then the original slow fetch resolves late and must be discarded.
    act(() => {
      resolveFirst([rec("stale")]);
    });
    await waitFor(() => {
      expect(result.current.hasLoaded).toBe(true);
    });
    expect(result.current.sessions.map((s) => s.sessionId)).toEqual(["fresh"]);
  });
});
