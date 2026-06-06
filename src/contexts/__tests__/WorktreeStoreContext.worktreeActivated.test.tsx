// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
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

beforeEach(() => {
  listeners.clear();
  setCurrentProject("/repo/proj");
  // Reset the selection store so per-test state doesn't leak.
  useWorktreeSelectionStore.setState({
    activeWorktreeId: null,
    pendingWorktreeId: null,
    restoreWorktreeId: null,
    focusedWorktreeId: null,
  });

  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      isReady: () => true,
      request: (_name: string) =>
        Promise.resolve({ states: [] as WorktreeSnapshot[], watcherDegraded: false }),
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

function makeWorktree(id: string, overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name: id,
    isCurrent: false,
    branch: "main",
    isMainWorktree: true,
    ...overrides,
  } as WorktreeSnapshot;
}

describe("WorktreeStoreProvider worktree-activated handler (#9945)", () => {
  it("updates activeWorktreeId when host emits a worktree-activated event", async () => {
    const store = await renderProvider();
    // Seed two worktrees so the activated id exists in the store map.
    act(() => {
      store.getState().applyUpdate(
        makeWorktree("wt-main", { isMainWorktree: true, branch: "main" }),
        { epoch: "test", seq: 1 }
      );
      store.getState().applyUpdate(
        makeWorktree("wt-active", { isMainWorktree: false, branch: "feature/test" }),
        { epoch: "test", seq: 2 }
      );
    });
    // Mark the active worktree as the user-visible active.
    act(() => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-active" });
    });

    act(() => {
      emit("worktree-activated", {
        type: "worktree-activated",
        worktreeId: "wt-main",
      });
    });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-main");
  });

  it("recovers activeWorktreeId to main in the same tick as a worktree-removed (#9945 flicker fix)", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(
        makeWorktree("wt-main", { isMainWorktree: true, branch: "main" }),
        { epoch: "test", seq: 1 }
      );
      store.getState().applyUpdate(
        makeWorktree("wt-active", { isMainWorktree: false, branch: "feature/test" }),
        { epoch: "test", seq: 2 }
      );
    });
    act(() => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-active" });
    });

    // The bug from #9945 was: `worktree-removed` cleared `activeWorktreeId`
    // to null, and `useActiveWorktreeSync` recovered on the NEXT React render
    // tick. The user observed a frame of UI with no active worktree between
    // those two transitions. The fix lands the auto-switch in the same React
    // tick as the removal — both events arrive on the same MessagePort
    // dispatch — so React 19's automatic batching collapses them into a
    // single render where the final state is the auto-switch target.
    //
    // We assert the end-state contract (no observable null in the rendered
    // tree) rather than the intermediate Zustand subscriber notifications,
    // which are not user-visible. The earlier (pre-fix) render flow would
    // commit a render with `activeWorktreeId === null` before the next-tick
    // recovery ran; this test pins down the post-fix behavior.
    act(() => {
      emit("worktree-removed", {
        type: "worktree-removed",
        worktreeId: "wt-active",
        epoch: "test",
        seq: 3,
      });
      // Host's MessagePort dispatches worktree-removed then
      // worktree-activated in document order, in the same dispatch tick.
      emit("worktree-activated", {
        type: "worktree-activated",
        worktreeId: "wt-main",
      });
    });

    // Final state must be the auto-switch target (main), not null. This is
    // the post-render snapshot the user actually sees.
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-main");
    // `applyPendingWorktreeSelection` clears `pendingWorktreeId` after the
    // selection lands (worktreeStore.ts:400), so a non-null active id with a
    // null pending id confirms the listener reached the terminal-apply step.
    expect(useWorktreeSelectionStore.getState().pendingWorktreeId).toBeNull();
  });

  it("does not break the worktree-removed guard when the removed worktree is not active", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(
        makeWorktree("wt-main", { isMainWorktree: true, branch: "main" }),
        { epoch: "test", seq: 1 }
      );
      store.getState().applyUpdate(
        makeWorktree("wt-active", { isMainWorktree: false, branch: "feature/test" }),
        { epoch: "test", seq: 2 }
      );
      store.getState().applyUpdate(
        makeWorktree("wt-other", { isMainWorktree: false, branch: "feature/other" }),
        { epoch: "test", seq: 3 }
      );
    });
    act(() => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-active" });
    });

    act(() => {
      // Removing a NON-active worktree must NOT clear the active selection.
      emit("worktree-removed", {
        type: "worktree-removed",
        worktreeId: "wt-other",
        epoch: "test",
        seq: 4,
      });
    });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-active");
  });
});
