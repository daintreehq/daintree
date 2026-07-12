import { describe, it, expect, vi, beforeEach } from "vitest";

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
    useScratchStore.setState({
      currentScratch: { id: "scratch-1", name: "s", path: "/tmp/s" } as never,
      scratches: [{ id: "scratch-1", name: "s", path: "/tmp/s" } as never],
    });

    onRemoved?.("scratch-1");

    expect(useScratchStore.getState().currentScratch).toBeNull();
    expect(useScratchStore.getState().scratches).toHaveLength(0);
  });
});
