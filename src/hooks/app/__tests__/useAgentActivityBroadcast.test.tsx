// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { AgentState } from "@shared/types/agent";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";

interface StubPanel {
  id: string;
  kind: string;
  location?: string;
  agentState?: AgentState;
}

interface StubState {
  panelIdsByWorktreeId: Record<string, string[]>;
  panelsById: Record<string, StubPanel>;
}

let storeState: StubState = { panelIdsByWorktreeId: {}, panelsById: {} };
const storeListeners = new Set<() => void>();

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => storeState,
    subscribe: (cb: () => void) => {
      storeListeners.add(cb);
      return () => storeListeners.delete(cb);
    },
  },
}));

import { useAgentActivityBroadcast } from "../useAgentActivityBroadcast";

function setPanels(
  panels: Array<{ worktreeId: string; agentState?: AgentState; location?: string; kind?: string }>
): void {
  const panelIdsByWorktreeId: Record<string, string[]> = {};
  const panelsById: Record<string, StubPanel> = {};
  panels.forEach((p, i) => {
    const id = `panel-${i}`;
    (panelIdsByWorktreeId[p.worktreeId] ??= []).push(id);
    panelsById[id] = {
      id,
      kind: p.kind ?? "terminal",
      location: p.location,
      agentState: p.agentState,
    };
  });
  storeState = { panelIdsByWorktreeId, panelsById };
  storeListeners.forEach((cb) => cb());
}

const requestMock = vi.fn(() => Promise.resolve({ ok: true as const }));
let readyCallback: (() => void) | null = null;
// Project-view lifecycle channels, driven through the real `viewCacheState`.
const viewHandlers = {
  cached: new Set<() => void>(),
  warm: new Set<() => void>(),
  revealed: new Set<() => void>(),
};

function emitView(set: Set<() => void>): void {
  act(() => {
    set.forEach((handler) => handler());
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  requestMock.mockClear();
  readyCallback = null;
  storeState = { panelIdsByWorktreeId: {}, panelsById: {} };
  storeListeners.clear();
  viewHandlers.cached.clear();
  viewHandlers.warm.clear();
  viewHandlers.revealed.clear();
  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      request: requestMock,
      onReady: (cb: () => void) => {
        readyCallback = cb;
        return () => {
          readyCallback = null;
        };
      },
    },
    app: {
      onViewCached: (cb: () => void) => {
        viewHandlers.cached.add(cb);
        return () => viewHandlers.cached.delete(cb);
      },
      onViewWarmActivated: (cb: () => void) => {
        viewHandlers.warm.add(cb);
        return () => viewHandlers.warm.delete(cb);
      },
      onViewRevealed: (cb: () => void) => {
        viewHandlers.revealed.add(cb);
        return () => viewHandlers.revealed.delete(cb);
      },
      isViewCached: () => false,
    },
  } as unknown as Window["electron"];
  // The singleton stays armed for the module's life; re-arm on this bridge.
  __resetProjectViewCacheStateForTests();
});

afterEach(() => {
  __resetProjectViewCacheStateForTests();
  vi.useRealTimers();
});

describe("useAgentActivityBroadcast", () => {
  it("broadcasts worktrees with working agents after the activation debounce", async () => {
    renderHook(() => useAgentActivityBroadcast());

    act(() => {
      setPanels([
        { worktreeId: "/wt/b", agentState: "working" },
        { worktreeId: "/wt/a", agentState: "directing" },
        { worktreeId: "/wt/idle", agentState: "idle" },
      ]);
    });
    expect(requestMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(requestMock).toHaveBeenCalledExactlyOnceWith("set-agent-activity", {
      worktreeIds: ["/wt/a", "/wt/b"],
    });
  });

  it("ignores trashed panels and the unassigned bucket", async () => {
    renderHook(() => useAgentActivityBroadcast());

    act(() => {
      setPanels([
        { worktreeId: "/wt/a", agentState: "working", location: "trash" },
        { worktreeId: "__none__", agentState: "working" },
      ]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(requestMock).not.toHaveBeenCalled();
  });

  it("a short working→waiting flap never reaches the host", async () => {
    renderHook(() => useAgentActivityBroadcast());

    act(() => {
      setPanels([{ worktreeId: "/wt/a", agentState: "working" }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Permission prompt: working → waiting → (approved) → working, faster
    // than the deactivation settle.
    act(() => {
      setPanels([{ worktreeId: "/wt/a", agentState: "waiting" }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    act(() => {
      setPanels([{ worktreeId: "/wt/a", agentState: "working" }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("deactivation settles before broadcasting the removal", async () => {
    renderHook(() => useAgentActivityBroadcast());

    act(() => {
      setPanels([{ worktreeId: "/wt/a", agentState: "working" }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(requestMock).toHaveBeenCalledTimes(1);

    act(() => {
      setPanels([{ worktreeId: "/wt/a", agentState: "completed" }]);
    });
    // Not yet — the settle window absorbs flaps.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(requestMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenLastCalledWith("set-agent-activity", { worktreeIds: [] });
  });

  it("a second deactivation resets the settle window instead of riding the first one's tail", async () => {
    renderHook(() => useAgentActivityBroadcast());

    act(() => {
      setPanels([
        { worktreeId: "/wt/a", agentState: "working" },
        { worktreeId: "/wt/b", agentState: "working" },
      ]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(requestMock).toHaveBeenCalledTimes(1);

    act(() => {
      setPanels([
        { worktreeId: "/wt/a", agentState: "completed" },
        { worktreeId: "/wt/b", agentState: "working" },
      ]);
    });
    // 4.9s into a's settle window, b also deactivates — it must get its own
    // full window, not fire 100ms later on a's timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_900);
    });
    act(() => {
      setPanels([
        { worktreeId: "/wt/a", agentState: "completed" },
        { worktreeId: "/wt/b", agentState: "waiting" },
      ]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_900);
    });
    expect(requestMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenLastCalledWith("set-agent-activity", { worktreeIds: [] });
  });

  it("unrelated store churn does not reset a pending deactivation's settle window", async () => {
    renderHook(() => useAgentActivityBroadcast());

    act(() => {
      setPanels([{ worktreeId: "/wt/a", agentState: "working" }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(requestMock).toHaveBeenCalledTimes(1);

    act(() => {
      setPanels([{ worktreeId: "/wt/a", agentState: "completed" }]);
    });
    // Unrelated mutations every second (focus moves, pings) leave the busy
    // set unchanged — the settle window must not restart each time.
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      act(() => {
        setPanels([{ worktreeId: "/wt/a", agentState: "completed" }]);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenLastCalledWith("set-agent-activity", { worktreeIds: [] });
  });

  it("retries a failed send without needing another store change", async () => {
    requestMock.mockRejectedValueOnce(new Error("port timeout"));
    renderHook(() => useAgentActivityBroadcast());

    act(() => {
      setPanels([{ worktreeId: "/wt/a", agentState: "working" }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(requestMock).toHaveBeenCalledTimes(1);

    // No further panel-store activity — the retry must self-schedule.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenLastCalledWith("set-agent-activity", {
      worktreeIds: ["/wt/a"],
    });
  });

  it("unmount cancels pending sends and unsubscribes", async () => {
    const { unmount } = renderHook(() => useAgentActivityBroadcast());

    act(() => {
      setPanels([{ worktreeId: "/wt/a", agentState: "working" }]);
    });
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    act(() => {
      setPanels([{ worktreeId: "/wt/b", agentState: "working" }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(requestMock).not.toHaveBeenCalled();
  });

  it("port reconnect during a deactivation settle re-elevates on the fast path", async () => {
    renderHook(() => useAgentActivityBroadcast());

    act(() => {
      setPanels([
        { worktreeId: "/wt/a", agentState: "working" },
        { worktreeId: "/wt/b", agentState: "working" },
      ]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(requestMock).toHaveBeenCalledTimes(1);

    // a deactivates — a 5s settle timer is now pending for the reduced set.
    act(() => {
      setPanels([
        { worktreeId: "/wt/a", agentState: "completed" },
        { worktreeId: "/wt/b", agentState: "working" },
      ]);
    });
    // Host restarts mid-settle. The fresh host holds an empty set, so the
    // still-working b is an ACTIVATION now — it must not ride out the
    // remaining settle window unelevated.
    act(() => {
      readyCallback?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenLastCalledWith("set-agent-activity", {
      worktreeIds: ["/wt/b"],
    });
  });

  it("re-sends the current set when the port reconnects (host restart)", async () => {
    renderHook(() => useAgentActivityBroadcast());

    act(() => {
      setPanels([{ worktreeId: "/wt/a", agentState: "working" }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Host restart: fresh epoch holds an empty agent-activity set.
    act(() => {
      readyCallback?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenLastCalledWith("set-agent-activity", {
      worktreeIds: ["/wt/a"],
    });
  });
  describe("cached project view (#12514)", () => {
    it("cancels a pending send when the view is cached", async () => {
      renderHook(() => useAgentActivityBroadcast());

      act(() => {
        setPanels([{ worktreeId: "/wt/a", agentState: "working" }]);
      });
      emitView(viewHandlers.cached);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(requestMock).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("drops a pending retry when the view is cached", async () => {
      // Main closes a cached view's worktree port, so a retry could only fail
      // and re-arm itself every settle window for as long as the view stays
      // cached.
      requestMock.mockRejectedValueOnce(new Error("port closed"));
      renderHook(() => useAgentActivityBroadcast());

      act(() => {
        setPanels([{ worktreeId: "/wt/a", agentState: "working" }]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(requestMock).toHaveBeenCalledTimes(1);

      emitView(viewHandlers.cached);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(requestMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops retrying once a send in flight fails after the view is cached", async () => {
      let rejectInFlight: (error: Error) => void = () => {};
      requestMock.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectInFlight = reject;
          })
      );
      renderHook(() => useAgentActivityBroadcast());

      act(() => {
        setPanels([{ worktreeId: "/wt/a", agentState: "working" }]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(requestMock).toHaveBeenCalledTimes(1);

      emitView(viewHandlers.cached);
      await act(async () => {
        rejectInFlight(new Error("port closed"));
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(requestMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("ignores store churn while cached and never announces an empty set", async () => {
      renderHook(() => useAgentActivityBroadcast());

      act(() => {
        setPanels([{ worktreeId: "/wt/a", agentState: "working" }]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(requestMock).toHaveBeenCalledTimes(1);

      emitView(viewHandlers.cached);
      act(() => {
        setPanels([{ worktreeId: "/wt/a", agentState: "completed" }]);
      });
      act(() => {
        setPanels([{ worktreeId: "/wt/b", agentState: "working" }]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("re-evaluates on warm activation and sends what changed while cached", async () => {
      renderHook(() => useAgentActivityBroadcast());

      act(() => {
        setPanels([{ worktreeId: "/wt/a", agentState: "working" }]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(requestMock).toHaveBeenCalledTimes(1);

      emitView(viewHandlers.cached);
      act(() => {
        setPanels([
          { worktreeId: "/wt/a", agentState: "working" },
          { worktreeId: "/wt/b", agentState: "working" },
        ]);
      });

      emitView(viewHandlers.warm);
      emitView(viewHandlers.revealed);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(requestMock).toHaveBeenCalledTimes(2);
      expect(requestMock).toHaveBeenLastCalledWith("set-agent-activity", {
        worktreeIds: ["/wt/a", "/wt/b"],
      });
    });

    it("resends a set whose send failed while cached once the view is activated", async () => {
      let rejectInFlight: (error: Error) => void = () => {};
      requestMock.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectInFlight = reject;
          })
      );
      renderHook(() => useAgentActivityBroadcast());

      act(() => {
        setPanels([{ worktreeId: "/wt/a", agentState: "working" }]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      emitView(viewHandlers.cached);
      await act(async () => {
        rejectInFlight(new Error("port closed"));
        await vi.advanceTimersByTimeAsync(0);
      });

      emitView(viewHandlers.warm);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(requestMock).toHaveBeenCalledTimes(2);
      expect(requestMock).toHaveBeenLastCalledWith("set-agent-activity", {
        worktreeIds: ["/wt/a"],
      });
    });

    it("unsubscribes from the view lifecycle on unmount", async () => {
      const { unmount } = renderHook(() => useAgentActivityBroadcast());
      emitView(viewHandlers.cached);
      act(() => {
        setPanels([{ worktreeId: "/wt/a", agentState: "working" }]);
      });
      unmount();

      emitView(viewHandlers.warm);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(requestMock).not.toHaveBeenCalled();
    });
  });
});
