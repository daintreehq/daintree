// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import {
  RENDERER_ACTIVATION_ORIGIN,
  consumeHostAppliedActivation,
  _resetHostAppliedActivationForTesting,
} from "@/store/worktreeActivationOrigin";
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
  _resetHostAppliedActivationForTesting();
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
      store
        .getState()
        .applyUpdate(makeWorktree("wt-main", { isMainWorktree: true, branch: "main" }), {
          epoch: "test",
          seq: 1,
        });
      store
        .getState()
        .applyUpdate(makeWorktree("wt-active", { isMainWorktree: false, branch: "feature/test" }), {
          epoch: "test",
          seq: 2,
        });
    });
    // Mark the active worktree as the user-visible active.
    act(() => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-active" });
    });

    act(() => {
      emit("worktree-activated", {
        type: "worktree-activated",
        worktreeId: "wt-main",
        epoch: "test",
        seq: 3,
      });
    });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-main");
  });

  it("recovers activeWorktreeId to main in the same tick as a worktree-removed (#9945 flicker fix)", async () => {
    const store = await renderProvider();
    act(() => {
      store
        .getState()
        .applyUpdate(makeWorktree("wt-main", { isMainWorktree: true, branch: "main" }), {
          epoch: "test",
          seq: 1,
        });
      store
        .getState()
        .applyUpdate(makeWorktree("wt-active", { isMainWorktree: false, branch: "feature/test" }), {
          epoch: "test",
          seq: 2,
        });
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
        epoch: "test",
        seq: 4,
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
      store
        .getState()
        .applyUpdate(makeWorktree("wt-main", { isMainWorktree: true, branch: "main" }), {
          epoch: "test",
          seq: 1,
        });
      store
        .getState()
        .applyUpdate(makeWorktree("wt-active", { isMainWorktree: false, branch: "feature/test" }), {
          epoch: "test",
          seq: 2,
        });
      store
        .getState()
        .applyUpdate(makeWorktree("wt-other", { isMainWorktree: false, branch: "feature/other" }), {
          epoch: "test",
          seq: 3,
        });
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

  it("early-returns when worktree-activated echoes the already-active id (#9512 invariant)", async () => {
    // The host's MessagePort echoes `worktree-activated` for both
    // Main-originated and host-originated activations. A redundant call
    // into `selectWorktree(activeId)` (default source: "user") would
    // update `restoreWorktreeId` and persist the active id — breaking
    // the focus-promotion invariant (#9512) by pinning a focus-promoted
    // id as the durable restore target. The listener's early-return
    // preserves the already-active path.
    const store = await renderProvider();
    act(() => {
      store
        .getState()
        .applyUpdate(makeWorktree("wt-main", { isMainWorktree: true, branch: "main" }), {
          epoch: "test",
          seq: 1,
        });
    });
    // Mark wt-main as active AND as the current restore target — the
    // host's echo must not perturb either.
    act(() => {
      useWorktreeSelectionStore.setState({
        activeWorktreeId: "wt-main",
        restoreWorktreeId: "wt-main",
        pendingWorktreeId: null,
      });
    });
    const restoreBefore = useWorktreeSelectionStore.getState().restoreWorktreeId;
    const pendingBefore = useWorktreeSelectionStore.getState().pendingWorktreeId;

    act(() => {
      emit("worktree-activated", {
        type: "worktree-activated",
        worktreeId: "wt-main",
        epoch: "test",
        seq: 2,
      });
    });

    const after = useWorktreeSelectionStore.getState();
    expect(after.activeWorktreeId).toBe("wt-main");
    // The early-return must leave restoreWorktreeId and pendingWorktreeId
    // untouched. If the listener had called selectWorktree("wt-main")
    // with source: "user", it would have re-confirmed restoreWorktreeId
    // (idempotent here, but a future focus-promoted id would have been
    // wrongly pinned) and cleared pendingWorktreeId via the
    // already-active branch.
    expect(after.restoreWorktreeId).toBe(restoreBefore);
    expect(after.pendingWorktreeId).toBe(pendingBefore);
  });
});

describe("WorktreeStoreProvider worktree-activated origin and version gates (#12370)", () => {
  async function renderWithWorktrees(ids: string[]) {
    const store = await renderProvider();
    act(() => {
      ids.forEach((id, i) => {
        store
          .getState()
          .applyUpdate(makeWorktree(id, { isMainWorktree: i === 0, branch: `b/${id}` }), {
            epoch: "test",
            seq: i + 1,
          });
      });
    });
    return store;
  }

  it("ignores the echo of this view's own set-active once the view has moved on", async () => {
    await renderWithWorktrees(["wt-a", "wt-b"]);
    // The view selected A, then B, and sent set-active for both. B is the
    // current selection when A's echo lands; re-applying A here is the first
    // hop of the A/B echo loop.
    act(() => {
      useWorktreeSelectionStore.setState({
        activeWorktreeId: "wt-b",
        restoreWorktreeId: "wt-b",
        pendingWorktreeId: null,
      });
    });

    act(() => {
      emit("worktree-activated", {
        type: "worktree-activated",
        worktreeId: "wt-a",
        epoch: "test",
        seq: 3,
        origin: RENDERER_ACTIVATION_ORIGIN,
      });
    });

    const after = useWorktreeSelectionStore.getState();
    expect(after.activeWorktreeId).toBe("wt-b");
    expect(after.restoreWorktreeId).toBe("wt-b");
    expect(after.pendingWorktreeId).toBeNull();
    // Nothing was applied, so there is nothing for the sync hook to withhold.
    expect(consumeHostAppliedActivation("wt-a")).toBe(false);
  });

  it("marks a host-pushed selection so the sync hook does not answer it with a set-active", async () => {
    await renderWithWorktrees(["wt-a", "wt-b"]);
    act(() => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-b" });
    });

    act(() => {
      emit("worktree-activated", {
        type: "worktree-activated",
        worktreeId: "wt-a",
        epoch: "test",
        seq: 3,
      });
    });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-a");
    // With two windows on one project, echoing the host's own activation back
    // is the next hop of a loop: each view applies the other's and re-sends.
    expect(consumeHostAppliedActivation("wt-a")).toBe(true);
  });

  it("still applies an activation carrying some other origin", async () => {
    await renderWithWorktrees(["wt-a", "wt-b"]);
    act(() => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-b" });
    });

    act(() => {
      emit("worktree-activated", {
        type: "worktree-activated",
        worktreeId: "wt-a",
        epoch: "test",
        seq: 3,
        origin: "renderer-someone-else",
      });
    });

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-a");
  });

  it("ignores an activation older than the newest one it has seen in the same epoch", async () => {
    await renderWithWorktrees(["wt-main", "wt-active", "wt-other"]);
    act(() => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-active" });
    });

    act(() => {
      emit("worktree-activated", {
        type: "worktree-activated",
        worktreeId: "wt-main",
        epoch: "test",
        seq: 5,
      });
    });
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-main");

    act(() => {
      emit("worktree-activated", {
        type: "worktree-activated",
        worktreeId: "wt-other",
        epoch: "test",
        seq: 4,
      });
    });
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-main");
  });

  it("accepts an activation from a new epoch regardless of its seq", async () => {
    await renderWithWorktrees(["wt-main", "wt-active", "wt-other"]);
    act(() => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-active" });
    });

    act(() => {
      emit("worktree-activated", {
        type: "worktree-activated",
        worktreeId: "wt-main",
        epoch: "e1",
        seq: 5,
      });
    });
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-main");

    // A host restart resets the counter; its first activation must win.
    act(() => {
      emit("worktree-activated", {
        type: "worktree-activated",
        worktreeId: "wt-other",
        epoch: "e2",
        seq: 1,
      });
    });
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-other");
  });
});
