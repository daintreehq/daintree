import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Scratch } from "@shared/types";

const switchMock = vi.hoisted(() => vi.fn<() => Promise<Scratch | null>>());

vi.mock("@/clients/scratchClient", () => ({
  scratchClient: {
    getAll: vi.fn(async () => []),
    getCurrent: vi.fn(async () => null),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(async () => undefined),
    switch: switchMock,
  },
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelIds: [], removePanel: vi.fn() }) },
}));

async function loadStore() {
  vi.resetModules();
  globalThis.__scratchStoreListeners__ = undefined;
  (globalThis as { window?: unknown }).window = {
    __DAINTREE_INITIAL_PROJECT__: { id: "scratch-a" },
    electron: { scratch: { onUpdated: vi.fn(), onRemoved: vi.fn(), onSwitch: vi.fn() } },
  };
  return (await import("../scratchStore")).useScratchStore;
}

const SHOWN = { id: "scratch-a", name: "A", path: "/s/a" } as Scratch;
const OTHER = { id: "scratch-b", name: "B", path: "/s/b" } as Scratch;

describe("scratchStore.switchScratch", () => {
  beforeEach(() => switchMock.mockReset());

  it("takes the scratch the window moved to", async () => {
    const store = await loadStore();
    store.setState({ currentScratch: SHOWN, scratches: [SHOWN, OTHER] });
    switchMock.mockResolvedValueOnce(OTHER);

    await store.getState().switchScratch(OTHER.id);

    expect(store.getState().currentScratch).toEqual(OTHER);
  });

  it("keeps what it shows when the window didn't move", async () => {
    const store = await loadStore();
    store.setState({ currentScratch: SHOWN, scratches: [SHOWN, OTHER] });
    // Another window had it, or a newer navigation in this one won.
    switchMock.mockResolvedValueOnce(null);

    await store.getState().switchScratch(OTHER.id);

    expect(store.getState().currentScratch).toEqual(SHOWN);
  });
});
