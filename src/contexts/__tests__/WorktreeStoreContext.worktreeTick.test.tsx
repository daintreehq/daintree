// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import type { WorktreeSnapshot } from "@shared/types";
import type { Project } from "@shared/types/project";
import { toWorktreeTick } from "@shared/utils/worktreeSnapshotTick";

vi.mock("@/store/wakeActiveWorktreeTerminals", () => ({
  restoreTerminalFocusOnReveal: () => false,
  wakeActiveWorktreeTerminals: vi.fn(() => Promise.resolve()),
}));

const TEST_EPOCH = "test-epoch";
const listeners = new Map<string, Set<(data: unknown) => void>>();

function emit(name: string, data: unknown): void {
  for (const cb of listeners.get(name) ?? []) cb(data);
}

function makeWorktree(overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id: "wt-1",
    worktreeId: "wt-1",
    generation: 1,
    path: "/repo/wt-1",
    name: "wt-1",
    isCurrent: false,
    branch: "feature",
    isMainWorktree: false,
    modifiedCount: 1,
    lastGitStatusCheckedAt: 100,
    workingTreeChangedAt: 100,
    ...overrides,
  } as WorktreeSnapshot;
}

beforeEach(() => {
  listeners.clear();
  useProjectStore.setState({
    currentProject: { id: "p1", name: "p1", path: "/repo/proj" } as unknown as Project,
  });
  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      isReady: () => true,
      request: () =>
        Promise.resolve({ states: [] as WorktreeSnapshot[], epoch: TEST_EPOCH, seq: 0 }),
      onEvent: (name: string, cb: (data: unknown) => void) => {
        let set = listeners.get(name);
        if (!set) {
          set = new Set();
          listeners.set(name, set);
        }
        set.add(cb);
        return () => set?.delete(cb);
      },
      onReady: () => () => {},
      onDisconnected: () => () => {},
      onFatalDisconnect: () => () => {},
    },
    worktree: {
      getAllIssueAssociations: () => Promise.resolve({}),
      getPRStatus: () => Promise.resolve(null),
    },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  listeners.clear();
  useProjectStore.setState({ currentProject: null });
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

function update(worktree: WorktreeSnapshot, seq: number, epoch = TEST_EPOCH) {
  act(() => emit("worktree-update", { worktree, epoch, seq }));
}

function tick(worktree: WorktreeSnapshot, seq: number, epoch = TEST_EPOCH) {
  act(() => emit("worktree-tick", { tick: toWorktreeTick(worktree), epoch, seq }));
}

describe("WorktreeStoreProvider worktree-tick handler", () => {
  it("advances the stamp side maps without replacing the row", async () => {
    const store = await renderProvider();
    update(makeWorktree(), 1);
    const mapBefore = store.getState().worktrees;

    tick(
      makeWorktree({
        lastGitStatusCheckedAt: 200,
        workingTreeChangedAt: 300,
        workingTreeChangedDirs: ["src"],
      }),
      2
    );

    const state = store.getState();
    expect(state.worktrees).toBe(mapBefore);
    expect(state.version).toEqual({ epoch: TEST_EPOCH, seq: 2 });
    expect(state.statusCheckedAt.get("wt-1")).toBe(200);
    expect(state.workingTreeChangedAtById.get("wt-1")).toBe(300);
  });

  it("re-merges against the host snapshot, not a row the renderer edited locally", async () => {
    // A full update re-applies the host's auto-detected issue over a local
    // clear (an issue detach); a tick standing in for it must do the same.
    const store = await renderProvider();
    update(makeWorktree({ issueNumber: 11, issueTitle: "Auto" }), 1);
    act(() => {
      const worktrees = new Map(store.getState().worktrees);
      worktrees.set("wt-1", {
        ...worktrees.get("wt-1")!,
        issueNumber: undefined,
        issueTitle: undefined,
      });
      store.setState({ worktrees });
    });

    tick(makeWorktree({ issueNumber: 11, issueTitle: "Auto", lastGitStatusCheckedAt: 200 }), 2);

    expect(store.getState().worktrees.get("wt-1")).toMatchObject({
      issueNumber: 11,
      issueTitle: "Auto",
    });
  });

  it("ignores a tick for a worktree this view has no host snapshot for", async () => {
    const store = await renderProvider();
    tick(makeWorktree({ id: "wt-2", worktreeId: "wt-2" }), 1);

    expect(store.getState().worktrees.has("wt-2")).toBe(false);
    expect(store.getState().workingTreeChangedAtById.has("wt-2")).toBe(false);
  });

  it("ignores a tick after the worktree was removed", async () => {
    const store = await renderProvider();
    update(makeWorktree(), 1);
    act(() =>
      emit("worktree-removed", { worktreeId: "wt-1", epoch: TEST_EPOCH, seq: 2, generation: 1 })
    );

    tick(makeWorktree({ workingTreeChangedAt: 900 }), 3);

    expect(store.getState().worktrees.has("wt-1")).toBe(false);
    expect(store.getState().workingTreeChangedAtById.get("wt-1")).not.toBe(900);
  });

  it("ignores a tick from another host run", async () => {
    const store = await renderProvider();
    update(makeWorktree(), 1);

    tick(makeWorktree({ workingTreeChangedAt: 900 }), 1, "restarted-host");

    expect(store.getState().workingTreeChangedAtById.get("wt-1")).toBe(100);
  });

  it("ignores a tick from another monitor incarnation", async () => {
    const store = await renderProvider();
    update(makeWorktree({ generation: 2 }), 1);

    tick(makeWorktree({ generation: 1, workingTreeChangedAt: 900 }), 2);

    expect(store.getState().workingTreeChangedAtById.get("wt-1")).toBe(100);
  });
});
