import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Scratch } from "@shared/types";

vi.mock("@/clients/scratchClient", () => ({
  scratchClient: {
    getAll: vi.fn(async () => []),
    getCurrent: vi.fn(async () => null),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(async () => undefined),
    switch: vi.fn(),
  },
}));

const panelStoreMock = vi.hoisted(() => ({
  panelIds: [] as string[],
  removePanel: vi.fn<(id: string) => void>(),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => panelStoreMock },
}));

type RemovedListener = (scratchId: string) => void;

let onRemoved: RemovedListener | undefined;

/**
 * Load scratchStore fresh with a seeded view identity. The module registers its
 * IPC listeners at import time behind a `globalThis` once-guard, so each case
 * resets modules and the guard to capture its own `onRemoved`.
 */
async function loadStoreForView(viewWorkspaceId: string | undefined): Promise<void> {
  vi.resetModules();
  globalThis.__scratchStoreListeners__ = undefined;
  onRemoved = undefined;

  // The suite runs in the node environment (vitest.config.ts), so stand up the
  // window surface the store reads: main seeds the view's workspace id here.
  (globalThis as { window?: unknown }).window = {
    __DAINTREE_INITIAL_PROJECT__: viewWorkspaceId ? { id: viewWorkspaceId } : undefined,
    electron: {
      scratch: {
        onUpdated: vi.fn(),
        onRemoved: vi.fn((cb: RemovedListener) => {
          onRemoved = cb;
        }),
        onSwitch: vi.fn(),
      },
    },
  };

  await import("../scratchStore");
}

describe("scratchStore — panel teardown on scratch removal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    panelStoreMock.panelIds = [];
  });

  it("removes every panel in the view that owns the deleted scratch", async () => {
    await loadStoreForView("scratch-1");
    panelStoreMock.panelIds = ["term-a", "term-b", "term-c"];

    onRemoved?.("scratch-1");
    await vi.waitFor(() => expect(panelStoreMock.removePanel).toHaveBeenCalledTimes(3));

    expect(panelStoreMock.removePanel.mock.calls.map((c) => c[0])).toEqual([
      "term-a",
      "term-b",
      "term-c",
    ]);
  });

  it("leaves a sibling view's panels untouched when a different scratch is deleted", async () => {
    // The removal is broadcast to EVERY view, so a project view must ignore it —
    // keying the teardown on the globally-replicated `currentScratch` would wipe
    // this view's live panels.
    await loadStoreForView("project-abc");
    panelStoreMock.panelIds = ["term-a", "term-b"];

    onRemoved?.("scratch-1");
    await Promise.resolve();
    await Promise.resolve();

    expect(panelStoreMock.removePanel).not.toHaveBeenCalled();
  });

  it("ignores the removal in a view with no workspace identity", async () => {
    await loadStoreForView(undefined);
    panelStoreMock.panelIds = ["term-a"];

    onRemoved?.("scratch-1");
    await Promise.resolve();
    await Promise.resolve();

    expect(panelStoreMock.removePanel).not.toHaveBeenCalled();
  });

  it("clears the current scratch pointer regardless of which view received the removal", async () => {
    await loadStoreForView("project-abc");
    const { useScratchStore } = await import("../scratchStore");
    const scratch: Scratch = {
      id: "scratch-1",
      name: "s",
      path: "/tmp/s",
      createdAt: 0,
      lastOpened: 0,
    };
    useScratchStore.setState({ currentScratch: scratch, scratches: [scratch] });

    onRemoved?.("scratch-1");

    expect(useScratchStore.getState().currentScratch).toBeNull();
    expect(useScratchStore.getState().scratches).toHaveLength(0);
  });
});

/**
 * Concurrent loads share one request (#11518).
 *
 * Boot hydration starts a fire-and-forget `loadScratches()`. The switcher then
 * awaits its own call before reading ids for the agent-status pull, so a second
 * caller that resolves early — rather than on the real work — makes the palette
 * read an empty list and omit every scratch from that pull.
 */
describe("scratchStore — concurrent loadScratches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("makes a concurrent caller await the load already in flight", async () => {
    await loadStoreForView("scratch-1");
    const { useScratchStore } = await import("../scratchStore");
    const { scratchClient } = await import("@/clients/scratchClient");

    let releaseGetAll: (value: Scratch[]) => void = () => {};
    const loaded: Scratch[] = [
      { id: "scratch-1", name: "Spike", path: "/tmp/s", createdAt: 0, lastOpened: 0 },
    ];
    vi.mocked(scratchClient.getAll).mockReturnValue(
      new Promise<Scratch[]>((resolve) => {
        releaseGetAll = resolve;
      })
    );

    const first = useScratchStore.getState().loadScratches();
    let secondSettled = false;
    const second = useScratchStore
      .getState()
      .loadScratches()
      .then(() => {
        secondSettled = true;
      });

    await Promise.resolve();
    // The whole point: resolving here would hand the caller an empty store.
    expect(secondSettled).toBe(false);
    expect(useScratchStore.getState().scratches).toHaveLength(0);

    releaseGetAll(loaded);
    await Promise.all([first, second]);

    expect(secondSettled).toBe(true);
    expect(useScratchStore.getState().scratches).toEqual(loaded);
    // One request served both callers.
    expect(vi.mocked(scratchClient.getAll)).toHaveBeenCalledTimes(1);
  });

  it("permits a fresh load once the in-flight one settles", async () => {
    await loadStoreForView("scratch-1");
    const { useScratchStore } = await import("../scratchStore");
    const { scratchClient } = await import("@/clients/scratchClient");

    await useScratchStore.getState().loadScratches();
    await useScratchStore.getState().loadScratches();

    expect(vi.mocked(scratchClient.getAll)).toHaveBeenCalledTimes(2);
  });

  it("clears the in-flight slot when the load rejects", async () => {
    await loadStoreForView("scratch-1");
    const { useScratchStore } = await import("../scratchStore");
    const { scratchClient } = await import("@/clients/scratchClient");

    vi.mocked(scratchClient.getAll).mockRejectedValueOnce(new Error("ipc down"));
    await expect(useScratchStore.getState().loadScratches()).rejects.toThrow("ipc down");

    // A wedged slot would make every later load resolve against a stale store.
    expect(useScratchStore.getState().isLoading).toBe(false);
    await expect(useScratchStore.getState().loadScratches()).resolves.toBeUndefined();
  });
});
