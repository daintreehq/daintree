import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

const { selectWorktree, notifyMock, view, dropped } = vi.hoisted(() => ({
  selectWorktree: vi.fn(),
  notifyMock: vi.fn(),
  view: { cached: false, listeners: new Set<(phase: string) => void>() },
  dropped: { pending: false, listeners: new Set<() => void>() },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => ({ selectWorktree }) },
}));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewCached: () => view.cached,
  subscribeProjectViewLifecycle: (listener: (phase: string) => void) => {
    view.listeners.add(listener);
    return () => view.listeners.delete(listener);
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

/** A worktree list, counting who still listens to it. */
function makeStore(initial: Partial<ListState> = {}) {
  const store = createStore<ListState>(() => ({
    isInitialized: false,
    isLoading: true,
    isReconnecting: false,
    error: null,
    worktrees: new Map(),
    ...initial,
  }));
  let listening = 0;
  const source = {
    getState: store.getState,
    subscribe: (listener: () => void) => {
      listening += 1;
      const off = store.subscribe(listener);
      return () => {
        listening -= 1;
        off();
      };
    },
  };
  return { store, source, listening: () => listening };
}

const LOADED = { isInitialized: true, isLoading: false } as const;

function restoreDroppedView(): void {
  dropped.pending = false;
  for (const listener of [...dropped.listeners]) listener();
}

beforeEach(() => {
  vi.useFakeTimers();
  selectWorktree.mockClear();
  notifyMock.mockClear();
  view.cached = false;
  view.listeners.clear();
  dropped.pending = false;
  dropped.listeners.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("landOnWorktree", () => {
  it("selects the worktree it names when the list is already known", () => {
    const { source, listening } = makeStore({
      ...LOADED,
      worktrees: worktreesOf("/repo", "/repo-a", "/repo-b"),
    });
    landOnWorktree("/repo-b", source);
    expect(selectWorktree).toHaveBeenCalledTimes(1);
    expect(selectWorktree).toHaveBeenCalledWith("/repo-b");
    expect(notifyMock).not.toHaveBeenCalled();
    expect(listening()).toBe(0);
  });

  it("waits for a list that arrives after the project showed, then selects once", () => {
    const { store, source } = makeStore();
    landOnWorktree("/repo-feature", source);
    expect(selectWorktree).not.toHaveBeenCalled();

    store.setState({ ...LOADED, worktrees: worktreesOf("/repo", "/repo-feature") });
    expect(selectWorktree).toHaveBeenCalledTimes(1);
    expect(selectWorktree).toHaveBeenCalledWith("/repo-feature");

    store.setState({ worktrees: worktreesOf("/repo", "/repo-feature", "/repo-other") });
    expect(selectWorktree).toHaveBeenCalledTimes(1);
  });

  it("says a worktree is gone, once, and leaves the selection alone after", () => {
    const { store, source } = makeStore({ ...LOADED, worktrees: worktreesOf("/repo") });
    landOnWorktree("/repo-feature", source);
    expect(selectWorktree).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0]).toMatchObject({
      type: "warning",
      title: "Worktree is gone",
    });

    store.setState({ worktrees: worktreesOf("/repo", "/repo-feature") });
    expect(selectWorktree).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("never reads a list it can't trust yet as the worktree being gone", () => {
    const { store, source } = makeStore({
      isInitialized: false,
      isLoading: false,
      worktrees: worktreesOf("/repo"),
    });
    landOnWorktree("/repo-feature", source);
    store.setState({ isInitialized: true, worktrees: new Map() });
    store.setState({ isReconnecting: true, worktrees: worktreesOf("/repo") });
    store.setState({ isReconnecting: false, error: "port closed" });
    store.setState({ error: null, isLoading: true });
    expect(notifyMock).not.toHaveBeenCalled();
    expect(selectWorktree).not.toHaveBeenCalled();

    store.setState({ isLoading: false, worktrees: worktreesOf("/repo", "/repo-feature") });
    expect(selectWorktree).toHaveBeenCalledWith("/repo-feature");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("lands again once a dropped view's restore has put its own selection back", () => {
    dropped.pending = true;
    const { source } = makeStore({ ...LOADED, worktrees: worktreesOf("/repo", "/repo-feature") });
    landOnWorktree("/repo-feature", source);
    // Landed already: a switch straight to the view starts no restore at all.
    expect(selectWorktree).toHaveBeenCalledTimes(1);
    expect(dropped.listeners.size).toBe(1);

    restoreDroppedView();
    expect(selectWorktree).toHaveBeenCalledTimes(2);
    expect(selectWorktree).toHaveBeenLastCalledWith("/repo-feature");
    expect(dropped.listeners.size).toBe(0);
  });

  it("says a worktree is gone across a dropped view's restore only once", () => {
    dropped.pending = true;
    const { source } = makeStore({ ...LOADED, worktrees: worktreesOf("/repo") });
    landOnWorktree("/repo-feature", source);
    restoreDroppedView();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(selectWorktree).not.toHaveBeenCalled();
  });

  it("starts nothing in a view that is already cached", () => {
    view.cached = true;
    const { store, source, listening } = makeStore();
    landOnWorktree("/repo-feature", source);
    store.setState({ ...LOADED, worktrees: worktreesOf("/repo-feature") });
    expect(selectWorktree).not.toHaveBeenCalled();
    expect(listening()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does nothing once cancelled, cached, or past its wait, and lets go of everything", () => {
    for (const end of ["cancel", "cached", "timeout"] as const) {
      selectWorktree.mockClear();
      const { store, source, listening } = makeStore();
      const cancel = landOnWorktree("/repo-feature", source);
      expect(listening()).toBe(1);
      if (end === "cancel") cancel();
      if (end === "cached") for (const listener of [...view.listeners]) listener("cached");
      if (end === "timeout") vi.advanceTimersByTime(60_000);

      store.setState({ ...LOADED, worktrees: worktreesOf("/repo", "/repo-feature") });
      expect(selectWorktree).not.toHaveBeenCalled();
      expect(listening()).toBe(0);
      expect(view.listeners.size).toBe(0);
      expect(dropped.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("gives a slow host's list time to arrive", () => {
    const { store, source } = makeStore();
    landOnWorktree("/repo-feature", source);
    vi.advanceTimersByTime(20_000);
    for (const listener of [...view.listeners]) listener("active");
    store.setState({ ...LOADED, worktrees: worktreesOf("/repo-feature") });
    expect(selectWorktree).toHaveBeenCalledWith("/repo-feature");
  });
});
