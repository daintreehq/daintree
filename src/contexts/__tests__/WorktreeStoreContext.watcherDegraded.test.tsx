// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import type { WorktreeSnapshot } from "@shared/types";
import type { Project } from "@shared/types/project";

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
  | "watcher-recovered";

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

beforeEach(() => {
  listeners.clear();
  initialWatcherDegraded = false;
  setCurrentProject("/repo/proj");

  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      isReady: () => true,
      request: (_name: string) =>
        Promise.resolve({
          states: [] as WorktreeSnapshot[],
          watcherDegraded: initialWatcherDegraded,
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
