// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { AgentState } from "@shared/types/agent";

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

beforeEach(() => {
  vi.useFakeTimers();
  requestMock.mockClear();
  readyCallback = null;
  storeState = { panelIdsByWorktreeId: {}, panelsById: {} };
  storeListeners.clear();
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
  } as unknown as Window["electron"];
});

afterEach(() => {
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
});
