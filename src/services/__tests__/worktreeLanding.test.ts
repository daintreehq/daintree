import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { WorktreeViewStoreApi } from "@/store/createWorktreeStore";

const { selectWorktree, notifyMock, lifecycle, dropped } = vi.hoisted(() => ({
  selectWorktree: vi.fn(),
  notifyMock: vi.fn(),
  lifecycle: new Set<(phase: string) => void>(),
  dropped: { pending: false, listeners: new Set<() => void>() },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => ({ selectWorktree }) },
}));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/lib/viewCacheState", () => ({
  subscribeProjectViewLifecycle: (listener: (phase: string) => void) => {
    lifecycle.add(listener);
    return () => lifecycle.delete(listener);
  },
}));
vi.mock("@/store/projectStore", () => ({
  isDroppedViewRestorePending: () => dropped.pending,
  onDroppedViewRestored: (listener: () => void) => {
    dropped.listeners.add(listener);
    return () => dropped.listeners.delete(listener);
  },
}));
vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

import { landOnWorktree } from "../worktreeLanding";

interface ListState {
  isInitialized: boolean;
  isLoading: boolean;
  isReconnecting: boolean;
  error: string | null;
  worktrees: Map<string, { id: string }>;
}

function worktreesOf(...ids: string[]): Map<string, { id: string }> {
  return new Map(ids.map((id) => [id, { id }]));
}

function makeStore(initial: Partial<ListState> = {}) {
  const store = createStore<ListState>(() => ({
    isInitialized: false,
    isLoading: true,
    isReconnecting: false,
    error: null,
    worktrees: new Map(),
    ...initial,
  }));
  return { store, api: store as unknown as WorktreeViewStoreApi };
}

const LOADED = { isInitialized: true, isLoading: false } as const;

beforeEach(() => {
  vi.useFakeTimers();
  selectWorktree.mockClear();
  notifyMock.mockClear();
  lifecycle.clear();
  dropped.pending = false;
  dropped.listeners.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("landOnWorktree", () => {
  it("selects a live worktree straight away when the list is already known", () => {
    const { api } = makeStore({ ...LOADED, worktrees: worktreesOf("/repo", "/repo-feature") });
    landOnWorktree("/repo-feature", api);
    expect(selectWorktree).toHaveBeenCalledWith("/repo-feature");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("waits for a list that arrives after the project showed, then selects", () => {
    const { store, api } = makeStore();
    landOnWorktree("/repo-feature", api);
    expect(selectWorktree).not.toHaveBeenCalled();

    store.setState({ ...LOADED, worktrees: worktreesOf("/repo", "/repo-feature") });
    expect(selectWorktree).toHaveBeenCalledTimes(1);
    expect(selectWorktree).toHaveBeenCalledWith("/repo-feature");

    // Done once: later list updates don't select again.
    store.setState({ worktrees: worktreesOf("/repo", "/repo-feature", "/repo-other") });
    expect(selectWorktree).toHaveBeenCalledTimes(1);
  });

  it("says a worktree is gone and leaves the selection alone", () => {
    const { api } = makeStore({ ...LOADED, worktrees: worktreesOf("/repo") });
    landOnWorktree("/repo-feature", api);
    expect(selectWorktree).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0]).toMatchObject({
      type: "warning",
      title: "Worktree is gone",
    });
  });

  it("never reads an empty, reconnecting or failed list as the worktree being gone", () => {
    const { store, api } = makeStore({ ...LOADED });
    landOnWorktree("/repo-feature", api);
    store.setState({ isReconnecting: true, worktrees: worktreesOf("/repo") });
    store.setState({ isReconnecting: false, error: "port closed" });
    store.setState({ error: null, isLoading: true });
    expect(notifyMock).not.toHaveBeenCalled();
    expect(selectWorktree).not.toHaveBeenCalled();

    store.setState({ isLoading: false, worktrees: worktreesOf("/repo", "/repo-feature") });
    expect(selectWorktree).toHaveBeenCalledWith("/repo-feature");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("lands only after a dropped view's restore has put its own selection back", () => {
    dropped.pending = true;
    const { api } = makeStore({ ...LOADED, worktrees: worktreesOf("/repo", "/repo-feature") });
    landOnWorktree("/repo-feature", api);
    expect(selectWorktree).not.toHaveBeenCalled();

    dropped.pending = false;
    for (const listener of [...dropped.listeners]) listener();
    expect(selectWorktree).toHaveBeenCalledWith("/repo-feature");
  });

  it("does nothing once cancelled, cached, or past its wait, and lets go of everything", () => {
    for (const end of ["cancel", "cached", "timeout"] as const) {
      selectWorktree.mockClear();
      const { store, api } = makeStore();
      const cancel = landOnWorktree("/repo-feature", api);
      if (end === "cancel") cancel();
      if (end === "cached") for (const listener of [...lifecycle]) listener("cached");
      if (end === "timeout") vi.advanceTimersByTime(60_000);

      store.setState({ ...LOADED, worktrees: worktreesOf("/repo", "/repo-feature") });
      expect(selectWorktree).not.toHaveBeenCalled();
      expect(lifecycle.size).toBe(0);
      expect(dropped.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("keeps waiting through a view that only becomes active again", () => {
    const { store, api } = makeStore();
    landOnWorktree("/repo-feature", api);
    for (const listener of [...lifecycle]) listener("active");
    store.setState({ ...LOADED, worktrees: worktreesOf("/repo-feature") });
    expect(selectWorktree).toHaveBeenCalledWith("/repo-feature");
  });
});
