// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import type { WorktreeSnapshot } from "@shared/types";
import type { Project } from "@shared/types/project";

const notifyMock = vi.fn<(payload: unknown) => string>(() => "notif-id");
vi.mock("@/lib/notify", () => ({
  notify: (payload: unknown) => notifyMock(payload),
}));

const dispatchMock = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

type PortEventName =
  | "worktree-update"
  | "worktree-removed"
  | "worktree-activated"
  | "pr-detected"
  | "pr-cleared"
  | "pr-detection-state"
  | "issue-detected"
  | "issue-not-found"
  | "inotify-limit-reached"
  | "emfile-limit-reached"
  | "watcher-recovered"
  | "topology-watcher-dark"
  | "topology-watcher-recovered";

const listeners = new Map<PortEventName, Set<(data: unknown) => void>>();

function emit(name: PortEventName, data: unknown): void {
  const set = listeners.get(name);
  if (!set) return;
  for (const cb of set) cb(data);
}

function setCurrentProject(path: string | null): void {
  const project = path ? ({ id: "p1", name: "p1", path } as unknown as Project) : null;
  useProjectStore.setState({ currentProject: project });
}

let initialWatcherDegraded = false;
let initialTopologyWatcherDark = false;

beforeEach(() => {
  listeners.clear();
  initialWatcherDegraded = false;
  initialTopologyWatcherDark = false;
  notifyMock.mockClear();
  dispatchMock.mockClear();
  setCurrentProject("/repo/proj");

  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      isReady: () => true,
      request: (_name: string) =>
        Promise.resolve({
          states: [] as WorktreeSnapshot[],
          watcherDegraded: initialWatcherDegraded,
          topologyWatcherDark: initialTopologyWatcherDark,
        }),
      onEvent: (name: PortEventName, cb: (data: unknown) => void) => {
        let set = listeners.get(name);
        if (!set) {
          set = new Set();
          listeners.set(name, set);
        }
        set.add(cb);
        return () => set?.delete(cb);
      },
      onReady: (_cb: () => void) => () => {},
      onDisconnected: (_cb: () => void) => () => {},
      onFatalDisconnect: (_cb: () => void) => () => {},
    },
    worktree: {
      getAllIssueAssociations: () => Promise.resolve({}),
      getPRStatus: () => Promise.resolve(null),
    },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  listeners.clear();
  setCurrentProject(null);
  vi.restoreAllMocks();
});

async function renderProvider() {
  const { WorktreeStoreProvider, WorktreeStoreContext } = await import("../WorktreeStoreContext");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WorktreeStoreProvider>{children}</WorktreeStoreProvider>
  );
  const { result } = renderHook(() => useContext(WorktreeStoreContext), { wrapper });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!result.current) throw new Error("WorktreeStoreContext is null");
  return result.current;
}

describe("WorktreeStoreProvider — watcher degraded indicator", () => {
  it("defaults watcherDegraded to false when the handshake reports healthy", async () => {
    const store = await renderProvider();
    expect(store.getState().watcherDegraded).toBe(false);
  });

  it("hydrates watcherDegraded from the get-all-states handshake (late-mount path)", async () => {
    initialWatcherDegraded = true;
    const store = await renderProvider();
    expect(store.getState().watcherDegraded).toBe(true);
  });

  it("sets watcherDegraded on inotify-limit-reached", async () => {
    const store = await renderProvider();
    expect(store.getState().watcherDegraded).toBe(false);

    act(() => {
      emit("inotify-limit-reached", { type: "inotify-limit-reached" });
    });

    expect(store.getState().watcherDegraded).toBe(true);
  });

  it("sets watcherDegraded on emfile-limit-reached", async () => {
    const store = await renderProvider();

    act(() => {
      emit("emfile-limit-reached", { type: "emfile-limit-reached" });
    });

    expect(store.getState().watcherDegraded).toBe(true);
  });

  it("clears watcherDegraded on watcher-recovered", async () => {
    const store = await renderProvider();

    act(() => {
      emit("inotify-limit-reached", { type: "inotify-limit-reached" });
    });
    expect(store.getState().watcherDegraded).toBe(true);

    act(() => {
      emit("watcher-recovered", { type: "watcher-recovered" });
    });
    expect(store.getState().watcherDegraded).toBe(false);
  });

  it("survives a degrade → recover → degrade cycle", async () => {
    const store = await renderProvider();

    act(() => emit("emfile-limit-reached", { type: "emfile-limit-reached" }));
    expect(store.getState().watcherDegraded).toBe(true);

    act(() => emit("watcher-recovered", { type: "watcher-recovered" }));
    expect(store.getState().watcherDegraded).toBe(false);

    act(() => emit("inotify-limit-reached", { type: "inotify-limit-reached" }));
    expect(store.getState().watcherDegraded).toBe(true);
  });
});

describe("WorktreeStoreProvider — topology-watcher-dark indicator (#9908)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults topologyWatcherDark to false when the handshake reports healthy", async () => {
    const store = await renderProvider();
    expect(store.getState().topologyWatcherDark).toBe(false);
  });

  it("hydrates topologyWatcherDark from the get-all-states handshake", async () => {
    initialTopologyWatcherDark = true;
    const store = await renderProvider();
    expect(store.getState().topologyWatcherDark).toBe(true);
  });

  it("sets topologyWatcherDark on topology-watcher-dark and clears on recovered", async () => {
    const store = await renderProvider();
    expect(store.getState().topologyWatcherDark).toBe(false);

    act(() => emit("topology-watcher-dark", { type: "topology-watcher-dark" }));
    expect(store.getState().topologyWatcherDark).toBe(true);

    act(() => emit("topology-watcher-recovered", { type: "topology-watcher-recovered" }));
    expect(store.getState().topologyWatcherDark).toBe(false);
  });

  it("escalates to a low-priority reconcile notification after 30s of sustained dark", async () => {
    vi.useFakeTimers();
    const store = await renderProvider();

    act(() => emit("topology-watcher-dark", { type: "topology-watcher-dark" }));
    expect(notifyMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]![0] as {
      priority?: string;
      action?: { label?: string; actionId?: string };
    };
    expect(payload.priority).toBe("low");
    expect(payload.action?.actionId).toBe("worktree.reconcileTopology");
    void store;
  });

  it("does not escalate if the dark state clears before 30s", async () => {
    vi.useFakeTimers();
    await renderProvider();

    act(() => emit("topology-watcher-dark", { type: "topology-watcher-dark" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    act(() => emit("topology-watcher-recovered", { type: "topology-watcher-recovered" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("arms the 30s escalation when a view mounts while already dark (hydration path)", async () => {
    vi.useFakeTimers();
    initialTopologyWatcherDark = true;
    const store = await renderProvider();
    expect(store.getState().topologyWatcherDark).toBe(true);
    expect(notifyMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to an unscoped supersedeKey when no project is loaded", async () => {
    vi.useFakeTimers();
    setCurrentProject(null);
    await renderProvider();

    act(() => emit("topology-watcher-dark", { type: "topology-watcher-dark" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    const payload = notifyMock.mock.calls[0]![0] as { supersedeKey?: string };
    expect(payload.supersedeKey).toBe("topology-watcher-dark");
  });

  it("dispatches worktree.reconcileTopology when the escalation action fires", async () => {
    vi.useFakeTimers();
    await renderProvider();

    act(() => emit("topology-watcher-dark", { type: "topology-watcher-dark" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    const payload = notifyMock.mock.calls[0]![0] as { action?: { onClick?: () => void } };
    act(() => {
      payload.action?.onClick?.();
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.reconcileTopology",
      undefined,
      expect.objectContaining({ source: "user" })
    );
  });
});
