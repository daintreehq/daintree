// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useWorktree, useWorktrees } from "../useWorktrees";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import type { WorktreeSnapshot } from "@shared/types";

vi.stubGlobal("electron", { worktreePort: { request: vi.fn(() => Promise.resolve()) } });

function snap(id: string, overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return { id, worktreeId: id, path: `/repo/${id}`, name: id, isCurrent: false, ...overrides };
}

function withStore(store: ReturnType<typeof createWorktreeStore>) {
  return ({ children }: { children: ReactNode }) => (
    <WorktreeStoreContext.Provider value={store}>{children}</WorktreeStoreContext.Provider>
  );
}

describe("useWorktrees identity", () => {
  it("keeps an unchanged worktree's object across an update to a sibling", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([snap("main", { isMainWorktree: true }), snap("a"), snap("b")], {
      epoch: "test",
      seq: 1,
    });

    const { result } = renderHook(() => useWorktrees(), { wrapper: withStore(store) });
    const before = result.current;

    act(() => {
      store.getState().applyUpdate(snap("a", { modifiedCount: 3 }), { epoch: "test", seq: 2 });
    });
    const after = result.current;

    expect(after.worktreeMap).not.toBe(before.worktreeMap);
    expect(after.worktreeMap.get("a")).not.toBe(before.worktreeMap.get("a"));
    expect(after.worktreeMap.get("a")?.modifiedCount).toBe(3);
    expect(after.worktreeMap.get("main")).toBe(before.worktreeMap.get("main"));
    expect(after.worktreeMap.get("b")).toBe(before.worktreeMap.get("b"));
    // The sorted list hands out the same objects as the map.
    for (const wt of after.worktrees) expect(wt).toBe(after.worktreeMap.get(wt.id));
    expect(after.worktrees.map((w) => w.id)).toEqual(["main", "a", "b"]);
  });

  it("still normalizes missing optional fields to null", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([snap("a")], { epoch: "test", seq: 1 });

    const { result } = renderHook(() => useWorktrees(), { wrapper: withStore(store) });

    expect(result.current.worktreeMap.get("a")?.worktreeChanges).toBeNull();
    expect(result.current.worktreeMap.get("a")?.lastActivityTimestamp).toBeNull();
  });

  it("useWorktree returns a stable object while its snapshot is unchanged", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([snap("a"), snap("b")], { epoch: "test", seq: 1 });

    const { result, rerender } = renderHook(() => useWorktree("a"), {
      wrapper: withStore(store),
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);

    act(() => {
      store.getState().applyUpdate(snap("b", { modifiedCount: 1 }), { epoch: "test", seq: 2 });
    });
    rerender();
    expect(result.current).toBe(first);
  });

  it("gives a removed then re-added worktree a fresh object", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([snap("a"), snap("b")], { epoch: "test", seq: 1 });

    const { result } = renderHook(() => useWorktrees(), { wrapper: withStore(store) });
    const original = result.current.worktreeMap.get("b");

    act(() => {
      store.getState().applySnapshot([snap("a")], { epoch: "test", seq: 2 });
    });
    expect(result.current.worktreeMap.has("b")).toBe(false);

    act(() => {
      store.getState().applySnapshot([snap("a"), snap("b", { modifiedCount: 2 })], {
        epoch: "test",
        seq: 3,
      });
    });
    expect(result.current.worktreeMap.get("b")).not.toBe(original);
    expect(result.current.worktreeMap.get("b")?.modifiedCount).toBe(2);
  });
});
