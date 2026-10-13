// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useWorktreeStoreOptional } from "../useWorktreeStore";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import type { WorktreeSnapshot } from "@shared/types";

function snap(id: string): WorktreeSnapshot {
  return { id, worktreeId: id, path: id, name: id, isCurrent: false };
}

function withStore(store: ReturnType<typeof createWorktreeStore> | null) {
  return ({ children }: { children: ReactNode }) => (
    <WorktreeStoreContext.Provider value={store}>{children}</WorktreeStoreContext.Provider>
  );
}

describe("useWorktreeStoreOptional", () => {
  it("hands back the fallback where no provider is mounted", () => {
    // The reason this variant exists: an overlay that only ENRICHES itself with
    // the current project's worktrees must render without them rather than take
    // the whole surface down over a detail it can do without.
    const { result } = renderHook(() => useWorktreeStoreOptional((s) => s.worktrees.size, -1));

    expect(result.current).toBe(-1);
  });

  it("reads the mounted store rather than the fallback", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([snap("wt-a"), snap("wt-b")], { epoch: "test", seq: 1 });

    const { result } = renderHook(() => useWorktreeStoreOptional((s) => s.worktrees.size, -1), {
      wrapper: withStore(store),
    });

    expect(result.current).toBe(2);
  });

  it("re-renders on a store change instead of holding the first read", () => {
    // Read once, this would go stale the moment a worktree is created or
    // deleted under an open surface — which is the whole reason it subscribes.
    const store = createWorktreeStore();
    store.getState().applySnapshot([snap("wt-a")], { epoch: "test", seq: 1 });

    const { result } = renderHook(() => useWorktreeStoreOptional((s) => s.worktrees.size, -1), {
      wrapper: withStore(store),
    });
    expect(result.current).toBe(1);

    act(() => {
      store.getState().applySnapshot([snap("wt-a"), snap("wt-b")], { epoch: "test", seq: 2 });
    });

    expect(result.current).toBe(2);
  });

  it("releases its subscription when the tree drops it", () => {
    // Asserted on the unsubscribe call, not on the value: a hook that leaked
    // its subscription would ALSO leave `result.current` at its last render,
    // because React drops an update aimed at an unmounted tree. Only the store
    // can say whether anyone is still listening.
    const store = createWorktreeStore();
    store.getState().applySnapshot([snap("wt-a")], { epoch: "test", seq: 1 });

    let unsubscribed = false;
    const watched = {
      ...store,
      subscribe: (listener: Parameters<typeof store.subscribe>[0]) => {
        const release = store.subscribe(listener);
        return () => {
          unsubscribed = true;
          release();
        };
      },
    };

    const { unmount } = renderHook(() => useWorktreeStoreOptional((s) => s.worktrees.size, -1), {
      wrapper: withStore(watched),
    });
    expect(unsubscribed).toBe(false);

    unmount();

    expect(unsubscribed).toBe(true);
  });
});
