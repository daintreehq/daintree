import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents, WebContentsView } from "electron";

const electronMock = vi.hoisted(() => ({
  fromWebContents: vi.fn(() => null),
  getAllWindows: vi.fn(() => []),
  // Typed at the source: the enumeration tests resolve ids to real mock
  // webContents, which a `() => null` inference would reject.
  fromId: vi.fn<(id: number) => WebContents | null>(() => null),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: electronMock.fromWebContents,
    getAllWindows: electronMock.getAllWindows,
  },
  WebContentsView: vi.fn(),
  webContents: {
    fromId: electronMock.fromId,
  },
}));

type MockWebContents = EventEmitter & {
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  setDestroyed: (next: boolean) => void;
  emitDestroyed: () => void;
};

function createWebContents(id: number): MockWebContents {
  let destroyed = false;
  const wc = new EventEmitter() as MockWebContents;
  wc.id = id;
  wc.isDestroyed = vi.fn(() => destroyed);
  wc.setDestroyed = (next: boolean) => {
    destroyed = next;
  };
  wc.emitDestroyed = () => {
    destroyed = true;
    wc.emit("destroyed");
  };
  return wc;
}

function createWindow(id: number): BrowserWindow {
  return {
    id,
    webContents: createWebContents(10_000 + id) as unknown as WebContents,
    isDestroyed: vi.fn(() => false),
  } as unknown as BrowserWindow;
}

function createView(webContents: MockWebContents): WebContentsView {
  return { webContents: webContents as unknown as WebContents } as unknown as WebContentsView;
}

async function loadRegistry() {
  vi.resetModules();
  electronMock.fromWebContents.mockReset();
  electronMock.fromWebContents.mockReturnValue(null);
  electronMock.getAllWindows.mockReset();
  electronMock.getAllWindows.mockReturnValue([]);
  electronMock.fromId.mockReset();
  electronMock.fromId.mockReturnValue(null);
  return import("../webContentsRegistry.js");
}

describe("webContentsRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not add duplicate destroyed listeners when an app view is reactivated", async () => {
    const { getAppWebContents, registerAppView } = await loadRegistry();
    const win = createWindow(1);
    const wc = createWebContents(101);
    const view = createView(wc);

    for (let i = 0; i < 20; i += 1) {
      registerAppView(win, view);
    }

    expect(wc.listenerCount("destroyed")).toBe(2);
    expect(getAppWebContents(win)).toBe(wc);

    wc.emitDestroyed();

    expect(wc.listenerCount("destroyed")).toBe(0);
    expect(getAppWebContents(win)).toBe(win.webContents);
  });

  it("keeps ProjectViewManager cold-start registration to one listener per concern", async () => {
    const { getProjectForWebContents, registerAppView, registerProjectView, registerWebContents } =
      await loadRegistry();
    const win = createWindow(1);
    const wc = createWebContents(102);
    const view = createView(wc);

    registerProjectView("project-a", wc as unknown as WebContents);
    registerWebContents(wc as unknown as WebContents, win);
    registerAppView(win, view);

    for (let i = 0; i < 20; i += 1) {
      registerWebContents(wc as unknown as WebContents, win);
      registerAppView(win, view);
      registerProjectView("project-a", wc as unknown as WebContents);
    }

    expect(wc.listenerCount("destroyed")).toBe(3);
    expect(getProjectForWebContents(wc.id)).toBe("project-a");
  });

  it("does not throw and falls back to win.webContents when the app view's webContents is undefined", async () => {
    const { getAppWebContents, getAppView, registerAppView } = await loadRegistry();
    const win = createWindow(1);
    const wc = createWebContents(104);
    const view = createView(wc);

    registerAppView(win, view);
    expect(getAppWebContents(win)).toBe(wc);

    // Electron 41 teardown race: the view is destroyed and view.webContents
    // becomes undefined before the `destroyed` event prunes windowToAppView.
    (view as unknown as { webContents: unknown }).webContents = undefined;

    expect(() => getAppWebContents(win)).not.toThrow();
    expect(getAppWebContents(win)).toBe(win.webContents);
    // Stale entry is pruned eagerly on read.
    expect(getAppView(win)).toBeNull();
  });

  it("falls back to win.webContents when the app view's webContents is destroyed but still present", async () => {
    const { getAppView, getAppWebContents, registerAppView } = await loadRegistry();
    const win = createWindow(1);
    const wc = createWebContents(107);
    const view = createView(wc);

    registerAppView(win, view);
    expect(getAppWebContents(win)).toBe(wc);

    // webContents object is still present (not undefined) but reports destroyed —
    // exercises the second half of the `view.webContents && !isDestroyed()` guard
    // without firing the `destroyed` event that would prune the map.
    wc.setDestroyed(true);

    expect(getAppWebContents(win)).toBe(win.webContents);
    expect(getAppView(win)).toBeNull();
  });

  it("getAllAppWebContents prunes only the stale window's app view, not live ones", async () => {
    const { getAllAppWebContents, getAppView, registerAppView } = await loadRegistry();
    const winA = createWindow(1);
    const winB = createWindow(2);
    const wcA = createWebContents(108);
    const wcB = createWebContents(109);
    const viewA = createView(wcA);
    const viewB = createView(wcB);

    registerAppView(winA, viewA);
    registerAppView(winB, viewB);

    (viewA as unknown as { webContents: unknown }).webContents = undefined;

    const result = getAllAppWebContents();
    expect(result).toEqual([wcB]);
    expect(getAppView(winA)).toBeNull();
    expect(getAppView(winB)).toBe(viewB);
  });

  it("getAllAppWebContents prunes app views whose webContents became undefined", async () => {
    const { getAllAppWebContents, getAppView, registerAppView } = await loadRegistry();
    const win = createWindow(1);
    const wc = createWebContents(105);
    const view = createView(wc);

    registerAppView(win, view);

    (view as unknown as { webContents: unknown }).webContents = undefined;
    // Fallback path returns live BrowserWindow webContents.
    electronMock.getAllWindows.mockReturnValue([win as unknown as never]);

    let result: WebContents[] = [];
    expect(() => {
      result = getAllAppWebContents();
    }).not.toThrow();
    expect(result).toEqual([win.webContents]);
    expect(getAppView(win)).toBeNull();
  });

  it("unregisterAppView does not throw when the view's webContents is undefined", async () => {
    const { getAppWebContents, registerAppView, unregisterAppView } = await loadRegistry();
    const win = createWindow(1);
    const wc = createWebContents(106);
    const view = createView(wc);

    registerAppView(win, view);
    (view as unknown as { webContents: unknown }).webContents = undefined;

    expect(() => unregisterAppView(win)).not.toThrow();
    expect(getAppWebContents(win)).toBe(win.webContents);
  });

  it("getRegisteredProjectViews pairs every live view with its project across windows", async () => {
    const { getRegisteredProjectViews, registerProjectView } = await loadRegistry();
    const wcA = createWebContents(301);
    const wcB = createWebContents(302);
    electronMock.fromId.mockImplementation(
      (id: number) => ({ 301: wcA, 302: wcB })[id] as unknown as WebContents
    );

    registerProjectView("project-a", wcA as unknown as WebContents);
    registerProjectView("project-b", wcB as unknown as WebContents);

    expect(getRegisteredProjectViews()).toEqual([
      { webContents: wcA, projectId: "project-a" },
      { webContents: wcB, projectId: "project-b" },
    ]);
  });

  it("getRegisteredProjectViews includes cached (deactivated) views", async () => {
    const { getRegisteredProjectViews, registerCachedViewWebContents, registerProjectView } =
      await loadRegistry();
    const wc = createWebContents(303);
    electronMock.fromId.mockImplementation((id: number) =>
      id === 303 ? (wc as unknown as WebContents) : null
    );

    registerProjectView("project-a", wc as unknown as WebContents);
    // Deactivation only marks the view; its renderer process stays alive.
    registerCachedViewWebContents(wc as unknown as WebContents);

    expect(getRegisteredProjectViews()).toEqual([{ webContents: wc, projectId: "project-a" }]);
  });

  it("getRegisteredProjectViews prunes only the stale view, keeping live ones", async () => {
    const {
      getProjectForWebContents,
      getRegisteredProjectViews,
      isCachedViewWebContents,
      registerCachedViewWebContents,
      registerProjectView,
    } = await loadRegistry();
    const staleWc = createWebContents(304);
    const liveWc = createWebContents(305);
    electronMock.fromId.mockImplementation(
      (id: number) => ({ 304: staleWc, 305: liveWc })[id] as unknown as WebContents
    );

    registerProjectView("project-a", staleWc as unknown as WebContents);
    registerCachedViewWebContents(staleWc as unknown as WebContents);
    registerProjectView("project-b", liveWc as unknown as WebContents);

    // Destroyed without firing "destroyed", so only the read-time prune can clear it.
    staleWc.setDestroyed(true);

    expect(getRegisteredProjectViews()).toEqual([{ webContents: liveWc, projectId: "project-b" }]);
    expect(getProjectForWebContents(staleWc.id)).toBeNull();
    expect(isCachedViewWebContents(staleWc.id)).toBe(false);
    expect(getProjectForWebContents(liveWc.id)).toBe("project-b");
    // Pruning a view that never fired "destroyed" must release its listener too,
    // or the registration keeps the WebContents and its closure alive.
    expect(staleWc.listenerCount("destroyed")).toBe(0);
    expect(liveWc.listenerCount("destroyed")).toBe(1);
  });

  it("getRegisteredProjectViews prunes views whose webContents no longer resolves", async () => {
    const { getProjectForWebContents, getRegisteredProjectViews, registerProjectView } =
      await loadRegistry();
    const wc = createWebContents(306);
    registerProjectView("project-a", wc as unknown as WebContents);

    // fromId returns null once Electron has torn the webContents down entirely.
    electronMock.fromId.mockReturnValue(null);

    expect(getRegisteredProjectViews()).toEqual([]);
    expect(getProjectForWebContents(wc.id)).toBeNull();
  });

  it("marks a webContents cached and clears the mark on unregister", async () => {
    const {
      isCachedViewWebContents,
      registerCachedViewWebContents,
      unregisterCachedViewWebContents,
    } = await loadRegistry();
    const wc = createWebContents(201);

    expect(isCachedViewWebContents(wc.id)).toBe(false);

    registerCachedViewWebContents(wc as unknown as WebContents);
    expect(isCachedViewWebContents(wc.id)).toBe(true);

    unregisterCachedViewWebContents(wc.id);
    expect(isCachedViewWebContents(wc.id)).toBe(false);

    // Idempotent: repeated calls neither throw nor flip state.
    unregisterCachedViewWebContents(wc.id);
    registerCachedViewWebContents(wc as unknown as WebContents);
    registerCachedViewWebContents(wc as unknown as WebContents);
    expect(isCachedViewWebContents(wc.id)).toBe(true);
  });

  it("clears the cached mark when the project view's webContents is destroyed", async () => {
    const { isCachedViewWebContents, registerCachedViewWebContents, registerProjectView } =
      await loadRegistry();
    const wc = createWebContents(202);

    registerProjectView("project-a", wc as unknown as WebContents);
    registerCachedViewWebContents(wc as unknown as WebContents);
    expect(isCachedViewWebContents(wc.id)).toBe(true);

    wc.emitDestroyed();
    expect(isCachedViewWebContents(wc.id)).toBe(false);
  });

  it("stale-prune in getAllAppWebContents clears the cached mark", async () => {
    const {
      getAllAppWebContents,
      isCachedViewWebContents,
      registerCachedViewWebContents,
      registerProjectView,
    } = await loadRegistry();
    const wc = createWebContents(204);

    registerProjectView("project-a", wc as unknown as WebContents);
    registerCachedViewWebContents(wc as unknown as WebContents);

    // fromId returns null (mock default) → the prune branch fires.
    getAllAppWebContents();

    expect(isCachedViewWebContents(wc.id)).toBe(false);
  });

  // #11100: the IPC context reads projects from this map precisely because it
  // spans windows, unlike a per-window ProjectViewManager. Both properties it
  // relies on are pinned here: senders resolve independently, and teardown is
  // scoped to the id that went away.
  it("resolves each window's project independently and survives another window's teardown", async () => {
    const { getProjectForWebContents, registerProjectView } = await loadRegistry();
    const viewA = createWebContents(301);
    const viewB = createWebContents(302);

    registerProjectView("project-a", viewA as unknown as WebContents);
    registerProjectView("project-b", viewB as unknown as WebContents);

    expect(getProjectForWebContents(viewA.id)).toBe("project-a");
    expect(getProjectForWebContents(viewB.id)).toBe("project-b");

    viewB.emitDestroyed();

    expect(getProjectForWebContents(viewB.id)).toBeNull();
    expect(getProjectForWebContents(viewA.id)).toBe("project-a");
  });

  it("clears the cached mark on unregisterProjectView so a reused id is never silenced", async () => {
    const {
      isCachedViewWebContents,
      registerCachedViewWebContents,
      registerProjectView,
      unregisterProjectView,
    } = await loadRegistry();
    const wc = createWebContents(203);

    registerProjectView("project-a", wc as unknown as WebContents);
    registerCachedViewWebContents(wc as unknown as WebContents);

    unregisterProjectView(wc.id);
    expect(isCachedViewWebContents(wc.id)).toBe(false);
  });

  describe("fallback-eligible project set (#12557)", () => {
    it("reports projects whose views hold no port, and drops one once it does", async () => {
      const { getFallbackEligibleProjectIds, registerProjectView, registerPortHolderWebContents } =
        await loadRegistry();
      const holder = createWebContents(201);
      const cached = createWebContents(202);

      registerProjectView("project-a", holder as unknown as WebContents);
      registerProjectView("project-b", cached as unknown as WebContents);
      expect(getFallbackEligibleProjectIds().sort()).toEqual(["project-a", "project-b"]);

      // Window 1's active view takes the port; project-a now has a transport
      // and no longer needs the fallback held open for it.
      registerPortHolderWebContents(1, holder.id);
      expect(getFallbackEligibleProjectIds()).toEqual(["project-b"]);
    });

    it("keeps a project eligible while a second view of it holds no port", async () => {
      // Window 1 shows A, window 2 has A cached. A must stay eligible.
      const { getFallbackEligibleProjectIds, registerProjectView, registerPortHolderWebContents } =
        await loadRegistry();
      const active = createWebContents(211);
      const duplicate = createWebContents(212);
      registerProjectView("project-a", active as unknown as WebContents);
      registerProjectView("project-a", duplicate as unknown as WebContents);

      registerPortHolderWebContents(1, active.id);

      expect(getFallbackEligibleProjectIds()).toEqual(["project-a"]);
    });

    it("re-opens eligibility the moment a holder gives up its port", async () => {
      // The reactivation gap: a view stops being cached before its replacement
      // port exists. Eligibility keyed on "holds no port" covers that interval;
      // keying it on "is cached" would starve the view for the paint gate.
      const {
        getFallbackEligibleProjectIds,
        registerProjectView,
        registerPortHolderWebContents,
        clearPortHolderWebContents,
      } = await loadRegistry();
      const wc = createWebContents(221);
      registerProjectView("project-a", wc as unknown as WebContents);
      registerPortHolderWebContents(1, wc.id);
      expect(getFallbackEligibleProjectIds()).toEqual([]);

      clearPortHolderWebContents(1);

      expect(getFallbackEligibleProjectIds()).toEqual(["project-a"]);
    });

    it("moves eligibility with the port on a project switch", async () => {
      const { getFallbackEligibleProjectIds, registerProjectView, registerPortHolderWebContents } =
        await loadRegistry();
      const viewA = createWebContents(231);
      const viewB = createWebContents(232);
      registerProjectView("project-a", viewA as unknown as WebContents);
      registerProjectView("project-b", viewB as unknown as WebContents);
      registerPortHolderWebContents(1, viewA.id);
      expect(getFallbackEligibleProjectIds()).toEqual(["project-b"]);

      // Same window, port handed to B's view: A becomes the port-less duplicate.
      registerPortHolderWebContents(1, viewB.id);

      expect(getFallbackEligibleProjectIds()).toEqual(["project-a"]);
    });

    it("publishes the current set on subscribe, then only on real changes", async () => {
      const {
        setFallbackEligibleProjectsListener,
        registerProjectView,
        registerPortHolderWebContents,
      } = await loadRegistry();
      const wc = createWebContents(241);
      registerProjectView("project-a", wc as unknown as WebContents);

      const listener = vi.fn();
      setFallbackEligibleProjectsListener(listener);
      expect(listener.mock.calls).toEqual([[["project-a"]]]);

      registerPortHolderWebContents(1, wc.id);
      expect(listener.mock.calls).toEqual([[["project-a"]], [[]]]);

      // Re-recording the same holder changes nothing — the host must not be
      // re-told on every re-broker.
      registerPortHolderWebContents(1, wc.id);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("drops a project when its port-less view is destroyed", async () => {
      // Otherwise the host keeps the fallback open for a project with no
      // port-less consumer left, paying a second main-process hop per chunk.
      const {
        setFallbackEligibleProjectsListener,
        registerProjectView,
        registerPortHolderWebContents,
      } = await loadRegistry();
      const holder = createWebContents(251);
      const duplicate = createWebContents(252);
      registerProjectView("project-a", holder as unknown as WebContents);
      registerProjectView("project-a", duplicate as unknown as WebContents);
      registerPortHolderWebContents(1, holder.id);

      const listener = vi.fn();
      setFallbackEligibleProjectsListener(listener);
      expect(listener.mock.calls).toEqual([[["project-a"]]]);

      duplicate.emitDestroyed();

      expect(listener.mock.calls).toEqual([[["project-a"]], [[]]]);
    });

    it("forgets a destroyed holder so its window stops excluding it", async () => {
      const { getPortHolderWebContentsId, registerProjectView, registerPortHolderWebContents } =
        await loadRegistry();
      const holder = createWebContents(261);
      registerProjectView("project-a", holder as unknown as WebContents);
      registerPortHolderWebContents(4, holder.id);
      expect(getPortHolderWebContentsId(4)).toBe(holder.id);

      holder.emitDestroyed();

      expect(getPortHolderWebContentsId(4)).toBeUndefined();
    });

    it("ignores a late port-replace teardown that names the previous holder (#12557)", async () => {
      // The host tears the replaced port down only after Main has brokered and
      // registered the replacement, so the notice for the departing holder
      // always lands last. Honouring it would leave the window holderless for
      // good — nothing re-registers outside a fresh handoff.
      const {
        getPortHolderWebContentsId,
        registerProjectView,
        registerPortHolderWebContents,
        clearPortHolderWebContentsIfCurrent,
      } = await loadRegistry();
      const outgoing = createWebContents(271);
      const incoming = createWebContents(272);
      registerProjectView("project-a", outgoing as unknown as WebContents);
      registerProjectView("project-a", incoming as unknown as WebContents);
      registerPortHolderWebContents(4, outgoing.id);
      registerPortHolderWebContents(4, incoming.id);

      clearPortHolderWebContentsIfCurrent(4, outgoing.id);

      expect(getPortHolderWebContentsId(4)).toBe(incoming.id);
    });

    it("clears when the teardown names the current holder (#12557)", async () => {
      const {
        getPortHolderWebContentsId,
        registerProjectView,
        registerPortHolderWebContents,
        clearPortHolderWebContentsIfCurrent,
      } = await loadRegistry();
      const holder = createWebContents(273);
      registerProjectView("project-a", holder as unknown as WebContents);
      registerPortHolderWebContents(4, holder.id);

      clearPortHolderWebContentsIfCurrent(4, holder.id);

      expect(getPortHolderWebContentsId(4)).toBeUndefined();
    });

    it("clears unconditionally when the teardown carries no identity (#12557)", async () => {
      const {
        getPortHolderWebContentsId,
        registerProjectView,
        registerPortHolderWebContents,
        clearPortHolderWebContentsIfCurrent,
      } = await loadRegistry();
      const holder = createWebContents(274);
      registerProjectView("project-a", holder as unknown as WebContents);
      registerPortHolderWebContents(4, holder.id);

      clearPortHolderWebContentsIfCurrent(4, undefined);

      expect(getPortHolderWebContentsId(4)).toBeUndefined();
    });
  });

  it("allows unregister and later re-register without leaving stale listener state", async () => {
    const { registerWebContents, unregisterWebContents } = await loadRegistry();
    const firstWindow = createWindow(1);
    const secondWindow = createWindow(2);
    const wc = createWebContents(103);

    registerWebContents(wc as unknown as WebContents, firstWindow);
    registerWebContents(wc as unknown as WebContents, firstWindow);
    expect(wc.listenerCount("destroyed")).toBe(1);

    unregisterWebContents(wc as unknown as WebContents);
    expect(wc.listenerCount("destroyed")).toBe(0);

    registerWebContents(wc as unknown as WebContents, secondWindow);
    expect(wc.listenerCount("destroyed")).toBe(1);
  });
});
