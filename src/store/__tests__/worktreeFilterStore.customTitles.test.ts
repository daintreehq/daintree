// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeTitlesSnapshot } from "@shared/types/ipc/worktreeTitles";

const PROJECT = "a".repeat(64);
const PROJECT_KEY = "daintree-worktree-filters:default";

type FilterStoreModule = typeof import("../worktreeFilterStore");
type ChangedCallback = (snapshot: WorktreeTitlesSnapshot) => void;

const snapshot = (titles: Record<string, string>, revision: number): WorktreeTitlesSnapshot => ({
  projectId: PROJECT,
  titles,
  revision,
});

/** Main's side of the bridge: a title map and revision the stub keeps like the real store. */
function installBridge(
  options: {
    hydrate?: (legacy: Record<string, string>) => Promise<WorktreeTitlesSnapshot | null>;
  } = {}
) {
  const listeners: ChangedCallback[] = [];
  let main: Record<string, string> | null = null;
  let revision = 0;
  const hydrate = vi.fn(
    options.hydrate ??
      (async (legacy: Record<string, string>) => {
        if (main === null) {
          main = { ...legacy };
          revision++;
        }
        return snapshot({ ...main }, revision);
      })
  );
  const set = vi.fn(async (id: string, title: string | null) => {
    main = { ...(main ?? {}) };
    if (title === null) delete main[id];
    else main[id] = title;
    revision++;
    return snapshot({ ...main }, revision);
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
    value: { worktreeTitles: { hydrate, set, onChanged } },
    configurable: true,
    writable: true,
  });
  return {
    hydrate,
    set,
    onChanged,
    listeners,
    push: (next: WorktreeTitlesSnapshot) => listeners.forEach((cb) => cb(next)),
  };
}

function seedLocalStorage(titles: Record<string, string>): void {
  localStorage.setItem(
    PROJECT_KEY,
    JSON.stringify({ state: { worktreeCustomTitles: titles }, version: 2 })
  );
}

/** A fresh module per test: the sync state is module-scoped, as it is per view. */
async function loadStore(): Promise<FilterStoreModule> {
  vi.resetModules();
  return import("../worktreeFilterStore");
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "electron");
  localStorage.clear();
});

describe("custom worktree titles held by main (#14022)", () => {
  it("hands main the titles kept in localStorage, then adopts what main holds", async () => {
    seedLocalStorage({ "wt-1": "Release prep" });
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

  it("reads again while the view is still unbound, then settles", async () => {
    vi.useFakeTimers();
    const replies: Array<WorktreeTitlesSnapshot | null> = [null, snapshot({ "wt-1": "Late" }, 1)];
    const bridge = installBridge({ hydrate: async () => replies.shift() ?? null });
    const { startWorktreeCustomTitlesSync, useWorktreeFilterStore } = await loadStore();

    const stop = startWorktreeCustomTitlesSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({});

    await vi.advanceTimersByTimeAsync(250);
    expect(bridge.hydrate).toHaveBeenCalledTimes(2);
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({ "wt-1": "Late" });
    stop();
  });

  it("hands over before the first write, and adopts main's reply", async () => {
    seedLocalStorage({ "wt-1": "Kept" });
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
    seedLocalStorage({ "wt-1": "Kept" });
    const bridge = installBridge({ hydrate: async () => null });
    const { useWorktreeFilterStore } = await loadStore();

    await expect(
      useWorktreeFilterStore.getState().setWorktreeCustomTitle("wt-1", "Changed")
    ).rejects.toThrow(/finishes opening/);
    expect(bridge.set).not.toHaveBeenCalled();
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({ "wt-1": "Kept" });
  });

  it("clears a stale worktree's title through main rather than only in this view", async () => {
    seedLocalStorage({ "wt-1": "Kept", "wt-gone": "Stale" });
    const bridge = installBridge();
    const { useWorktreeFilterStore } = await loadStore();

    useWorktreeFilterStore.getState().pruneStaleWorktreeIds(new Set(["wt-1"]));
    await flush();

    expect(bridge.set).toHaveBeenCalledTimes(1);
    expect(bridge.set).toHaveBeenCalledWith("wt-gone", null);
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({ "wt-1": "Kept" });
  });
});
