// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeTitlesSnapshot } from "@shared/types/ipc/worktreeTitles";

const PROJECT = "a".repeat(64);
const LOCAL_KEY = "daintree-worktree-filters:default";

type FilterStoreModule = typeof import("../worktreeFilterStore");
type ChangedCallback = (snapshot: WorktreeTitlesSnapshot) => void;

const snapshot = (titles: Record<string, string>, revision: number): WorktreeTitlesSnapshot => ({
  projectId: PROJECT,
  titles,
  revision,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Main's side of the bridge, kept like the real store: a hand-over fills only
 * worktrees main has no record of, and a clear is remembered.
 */
function installBridge(
  options: {
    hydrate?: (legacy: Record<string, string>) => Promise<WorktreeTitlesSnapshot | null>;
  } = {}
) {
  const listeners: ChangedCallback[] = [];
  const recorded: Record<string, string | null> = {};
  let revision = 0;
  const visible = () =>
    Object.fromEntries(
      Object.entries(recorded).filter((entry): entry is [string, string] => entry[1] !== null)
    );
  const hydrate = vi.fn(
    options.hydrate ??
      (async (legacy: Record<string, string>) => {
        let landed = false;
        for (const [id, title] of Object.entries(legacy)) {
          if (Object.hasOwn(recorded, id)) continue;
          recorded[id] = title;
          landed = true;
        }
        if (landed) revision++;
        return snapshot(visible(), revision);
      })
  );
  const set = vi.fn(async (id: string, title: string | null) => {
    recorded[id] = title;
    revision++;
    return snapshot(visible(), revision);
  });
  const prune = vi.fn(async (ids: string[]) => {
    for (const id of ids) recorded[id] = null;
    revision++;
    return snapshot(visible(), revision);
  });
  const onChanged = vi.fn((cb: ChangedCallback) => {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  });
  // `defineProperty` rather than an assignment + cast: a partial stub of the
  // full `ElectronAPI` would need a type assertion the lint ratchet counts.
  Object.defineProperty(window, "electron", {
    value: { worktreeTitles: { hydrate, set, prune, onChanged } },
    configurable: true,
    writable: true,
  });
  return {
    hydrate,
    set,
    prune,
    listeners,
    push: (next: WorktreeTitlesSnapshot) => listeners.forEach((cb) => cb(next)),
  };
}

function seedLocalStorage(key: string, titles: Record<string, string>): void {
  localStorage.setItem(
    key,
    JSON.stringify({ state: { worktreeCustomTitles: titles }, version: 2 })
  );
}

/** A fresh module per test: the sync state is module-scoped, as it is per view. */
async function loadStore(): Promise<FilterStoreModule> {
  vi.resetModules();
  return import("../worktreeFilterStore");
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  // Before the import, so the store's debounced persistence timers are fake
  // too and can't land in a later test's storage.
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "electron");
  Reflect.deleteProperty(window, "__DAINTREE_HOST_ID__");
  localStorage.clear();
});

describe("custom worktree titles held by main (#14022)", () => {
  it("hands main the titles kept in localStorage, then adopts what main holds", async () => {
    seedLocalStorage(LOCAL_KEY, { "wt-1": "Release prep" });
    const bridge = installBridge({
      hydrate: async () => snapshot({ "wt-1": "Release prep", "wt-2": "From main" }, 4),
    });
    const { startWorktreeCustomTitlesSync, useWorktreeFilterStore } = await loadStore();

    const stop = startWorktreeCustomTitlesSync();
    await flush();

    expect(bridge.hydrate).toHaveBeenCalledWith({ "wt-1": "Release prep" });
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({
      "wt-1": "Release prep",
      "wt-2": "From main",
    });
    stop();
    expect(bridge.listeners).toHaveLength(0);
  });

  it("adopts a rename another view made, and drops an older snapshot after a newer one", async () => {
    const bridge = installBridge();
    const { startWorktreeCustomTitlesSync, useWorktreeFilterStore } = await loadStore();
    const stop = startWorktreeCustomTitlesSync();
    await flush();

    bridge.push(snapshot({ "wt-1": "Newer" }, 5));
    bridge.push(snapshot({ "wt-1": "Older" }, 3));

    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({ "wt-1": "Newer" });
    stop();
  });

  it("holds a push that beats the hand-over, so the copy it hands over is the original", async () => {
    seedLocalStorage(LOCAL_KEY, { "wt-1": "Legacy" });
    const reply = deferred<WorktreeTitlesSnapshot | null>();
    const bridge = installBridge({ hydrate: () => reply.promise });
    const { startWorktreeCustomTitlesSync, useWorktreeFilterStore } = await loadStore();
    const stop = startWorktreeCustomTitlesSync();

    bridge.push(snapshot({ "wt-2": "Remote rename" }, 2));
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({ "wt-1": "Legacy" });

    reply.resolve(snapshot({ "wt-1": "Legacy" }, 1));
    await flush();

    expect(bridge.hydrate).toHaveBeenCalledWith({ "wt-1": "Legacy" });
    // The held push is newer than the reply, so it lands after it.
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({
      "wt-2": "Remote rename",
    });
    stop();
  });

  it("reads again while the view is still unbound, then settles", async () => {
    const replies: Array<WorktreeTitlesSnapshot | null> = [null, snapshot({ "wt-1": "Late" }, 1)];
    const bridge = installBridge({ hydrate: async () => replies.shift() ?? null });
    const { startWorktreeCustomTitlesSync, useWorktreeFilterStore } = await loadStore();

    const stop = startWorktreeCustomTitlesSync();
    await flush();
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({});

    await vi.advanceTimersByTimeAsync(250);
    expect(bridge.hydrate).toHaveBeenCalledTimes(2);
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({ "wt-1": "Late" });
    stop();
  });

  it("reads again, without handing anything over, when a remote view's link comes back", async () => {
    const bridge = installBridge();
    const { startWorktreeCustomTitlesSync, useWorktreeFilterStore } = await loadStore();
    const { notifyHostResync } = await import("../hostResyncSignal");
    const stop = startWorktreeCustomTitlesSync();
    await flush();
    bridge.hydrate.mockImplementationOnce(async () => snapshot({ "wt-1": "Missed rename" }, 7));

    notifyHostResync();
    await flush();

    expect(bridge.hydrate).toHaveBeenLastCalledWith({});
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({
      "wt-1": "Missed rename",
    });
    stop();
  });

  it("hands over before the first write, and adopts main's reply", async () => {
    seedLocalStorage(LOCAL_KEY, { "wt-1": "Kept" });
    const bridge = installBridge();
    const { useWorktreeFilterStore } = await loadStore();

    await useWorktreeFilterStore.getState().setWorktreeCustomTitle("wt-2", "  New   one ");

    expect(bridge.hydrate).toHaveBeenCalledTimes(1);
    expect(bridge.hydrate.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.set.mock.invocationCallOrder[0]!
    );
    expect(bridge.set).toHaveBeenCalledWith("wt-2", "New one");
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({
      "wt-1": "Kept",
      "wt-2": "New one",
    });
  });

  it("sends a clear to main, whatever the view's copy holds", async () => {
    const bridge = installBridge();
    const { useWorktreeFilterStore } = await loadStore();

    await useWorktreeFilterStore.getState().setWorktreeCustomTitle("wt-1", null);

    expect(bridge.set).toHaveBeenCalledWith("wt-1", null);
  });

  it("rejects a write while main can't name the project, leaving the copy alone", async () => {
    seedLocalStorage(LOCAL_KEY, { "wt-1": "Kept" });
    const bridge = installBridge({ hydrate: async () => null });
    const { useWorktreeFilterStore } = await loadStore();

    await expect(
      useWorktreeFilterStore.getState().setWorktreeCustomTitle("wt-1", "Changed")
    ).rejects.toThrow(/finishes opening/);
    expect(bridge.set).not.toHaveBeenCalled();
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({ "wt-1": "Kept" });
  });

  it("asks main to prune a stale worktree's title rather than dropping it only here", async () => {
    seedLocalStorage(LOCAL_KEY, { "wt-1": "Kept", "wt-gone": "Stale" });
    const bridge = installBridge();
    const { useWorktreeFilterStore } = await loadStore();

    useWorktreeFilterStore.getState().pruneStaleWorktreeIds(new Set(["wt-1"]));
    await flush();

    expect(bridge.prune).toHaveBeenCalledTimes(1);
    expect(bridge.prune).toHaveBeenCalledWith(["wt-gone"]);
    expect(bridge.set).not.toHaveBeenCalled();
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({ "wt-1": "Kept" });
  });

  it("keeps a remote view's copy apart from the local project with the same id", async () => {
    seedLocalStorage(LOCAL_KEY, { "wt-1": "This machine's" });
    Object.defineProperty(window, "__DAINTREE_HOST_ID__", {
      value: { id: "studio-mac" },
      configurable: true,
      writable: true,
    });
    const bridge = installBridge({
      hydrate: async () => snapshot({ "wt-1": "The host's" }, 3),
    });
    const { startWorktreeCustomTitlesSync, useWorktreeFilterStore } = await loadStore();

    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({});
    const stop = startWorktreeCustomTitlesSync();
    await flush();
    expect(bridge.hydrate).toHaveBeenCalledWith({});
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({
      "wt-1": "The host's",
    });

    // The adopted copy persists under the host's key, never the local one.
    await vi.advanceTimersByTimeAsync(300);
    expect(JSON.parse(localStorage.getItem(LOCAL_KEY)!).state.worktreeCustomTitles).toEqual({
      "wt-1": "This machine's",
    });
    stop();
  });

  it("reads once more after a pull that was in flight when the link came back", async () => {
    const bridge = installBridge();
    const { startWorktreeCustomTitlesSync, useWorktreeFilterStore } = await loadStore();
    const { notifyHostResync } = await import("../hostResyncSignal");
    const stop = startWorktreeCustomTitlesSync();
    await flush();

    const stale = deferred<WorktreeTitlesSnapshot | null>();
    bridge.hydrate.mockImplementationOnce(() => stale.promise);
    bridge.hydrate.mockImplementationOnce(async () => snapshot({ "wt-1": "After the drop" }, 9));
    notifyHostResync();
    notifyHostResync();
    stale.resolve(snapshot({ "wt-1": "Before the drop" }, 2));
    await flush();

    expect(bridge.hydrate).toHaveBeenCalledTimes(3);
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({
      "wt-1": "After the drop",
    });
    stop();
  });

  it("carries a remote view's pins and labels over from the old key, but not its titles", async () => {
    localStorage.setItem(
      LOCAL_KEY,
      JSON.stringify({
        state: {
          pinnedWorktrees: ["wt-1"],
          worktreeLabelColors: { "wt-1": "category-teal" },
          worktreeCustomTitles: { "wt-1": "This machine's" },
        },
        version: 2,
      })
    );
    Object.defineProperty(window, "__DAINTREE_HOST_ID__", {
      value: { id: "studio-mac" },
      configurable: true,
      writable: true,
    });
    installBridge();
    const { useWorktreeFilterStore } = await loadStore();

    const state = useWorktreeFilterStore.getState();
    expect(state.pinnedWorktrees).toEqual(["wt-1"]);
    expect(state.worktreeLabelColors).toEqual({ "wt-1": "category-teal" });
    expect(state.worktreeCustomTitles).toEqual({});
  });
});
