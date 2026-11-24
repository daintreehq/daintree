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

type SwitchListener = (payload: { scratch: Scratch | null; switchId: string } | null) => void;

async function loadStore(viewWorkspaceId: string | null = "scratch-a") {
  vi.resetModules();
  globalThis.__scratchStoreListeners__ = undefined;
  const onSwitch = vi.fn<(listener: SwitchListener) => void>();
  (globalThis as { window?: unknown }).window = {
    ...(viewWorkspaceId ? { __DAINTREE_INITIAL_PROJECT__: { id: viewWorkspaceId } } : {}),
    location: { href: "http://localhost:5173/" },
    electron: { scratch: { onUpdated: vi.fn(), onRemoved: vi.fn(), onSwitch } },
  };
  const store = (await import("../scratchStore")).useScratchStore;
  return { store, emitSwitch: onSwitch.mock.calls[0]![0] };
}

const SHOWN = { id: "scratch-a", name: "A", path: "/s/a" } as Scratch;
const OTHER = { id: "scratch-b", name: "B", path: "/s/b" } as Scratch;

describe("scratchStore.switchScratch", () => {
  beforeEach(() => switchMock.mockReset());

  it("keeps the view's own scratch when the window moves to another (#17186)", async () => {
    // The answer reaches the view the window left; the scratch's own view is
    // the one main tells it switched.
    const { store } = await loadStore();
    const reopened = { ...OTHER, lastOpened: 5 } as Scratch;
    store.setState({ currentScratch: SHOWN, scratches: [SHOWN, OTHER] });
    switchMock.mockResolvedValueOnce(reopened);

    await store.getState().switchScratch(OTHER.id);

    expect(store.getState().currentScratch).toEqual(SHOWN);
    expect(store.getState().scratches).toEqual([SHOWN, reopened]);
  });

  it("takes the scratch the window moved to in a view with no workspace of its own", async () => {
    const { store } = await loadStore(null);
    store.setState({ currentScratch: SHOWN, scratches: [SHOWN, OTHER] });
    switchMock.mockResolvedValueOnce(OTHER);

    await store.getState().switchScratch(OTHER.id);

    expect(store.getState().currentScratch).toEqual(OTHER);
  });

  it("keeps what it shows when the window didn't move", async () => {
    const { store } = await loadStore();
    store.setState({ currentScratch: SHOWN, scratches: [SHOWN, OTHER] });
    // Another window had it, or a newer navigation in this one won.
    switchMock.mockResolvedValueOnce(null);

    await store.getState().switchScratch(OTHER.id);

    expect(store.getState().currentScratch).toEqual(SHOWN);
  });
});

describe("scratchStore scratch:on-switch", () => {
  it("takes the scratch its own view was switched to", async () => {
    const { store, emitSwitch } = await loadStore();

    emitSwitch({ scratch: SHOWN, switchId: "s1" });

    expect(store.getState().currentScratch).toEqual(SHOWN);
  });

  it("ignores a scratch that belongs to another view (#17186)", async () => {
    // A view of scratch A keeps showing A when told about B.
    const { store, emitSwitch } = await loadStore();
    store.setState({ currentScratch: SHOWN });

    emitSwitch({ scratch: OTHER, switchId: "s1" });

    expect(store.getState().currentScratch).toEqual(SHOWN);
  });

  it("leaves a project's view without a scratch when told about one", async () => {
    const { store, emitSwitch } = await loadStore("project-1");

    emitSwitch({ scratch: OTHER, switchId: "s1" });

    expect(store.getState().currentScratch).toBeNull();
  });

  it("clears the scratch when its view was switched to a project", async () => {
    const { store, emitSwitch } = await loadStore("project-1");
    store.setState({ currentScratch: SHOWN });

    emitSwitch({ scratch: null, switchId: "" });

    expect(store.getState().currentScratch).toBeNull();
  });
});
