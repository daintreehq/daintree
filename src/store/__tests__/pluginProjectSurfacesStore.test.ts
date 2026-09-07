// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSurfaceSnapshot } from "@shared/types/plugin";
import {
  _resetPluginProjectSurfacesStoreForTest,
  usePluginProjectSurfacesStore,
} from "../pluginProjectSurfacesStore";

const claim = { pluginId: "project__p1__acme.dash", panelKindId: "project:p1/acme.dash/overview" };

type KindsCallback = () => void;

function installBridge(surfaces: ProjectSurfaceSnapshot | (() => Promise<ProjectSurfaceSnapshot>)) {
  const listeners: KindsCallback[] = [];
  const getProjectSurfaces = vi.fn(
    typeof surfaces === "function" ? surfaces : () => Promise.resolve(surfaces)
  );
  const onPanelKindsChanged = vi.fn((cb: KindsCallback) => {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  });
  // `defineProperty` rather than an assignment + cast: `window.electron` is a
  // full `ElectronAPI`, and every partial stub of it needs a type assertion the
  // lint ratchet counts. The descriptor takes the value untyped.
  Object.defineProperty(window, "electron", {
    value: { plugin: { getProjectSurfaces, onPanelKindsChanged } },
    configurable: true,
    writable: true,
  });
  return { getProjectSurfaces, onPanelKindsChanged, listeners };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  _resetPluginProjectSurfacesStoreForTest();
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
  _resetPluginProjectSurfacesStoreForTest();
});

describe("pluginProjectSurfacesStore", () => {
  it("pulls the sender project's surfaces on init", async () => {
    const bridge = installBridge({ emptyCanvas: claim });

    usePluginProjectSurfacesStore.getState().init();
    await flush();

    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({ emptyCanvas: claim });
    // The pull carries no project id — main resolves it from the sender, which
    // is what makes reading another project's surfaces impossible from here.
    expect(bridge.getProjectSurfaces).toHaveBeenCalledWith();
  });

  it("is idempotent", async () => {
    const bridge = installBridge({ emptyCanvas: claim });

    usePluginProjectSurfacesStore.getState().init();
    usePluginProjectSurfacesStore.getState().init();
    await flush();

    expect(bridge.getProjectSurfaces).toHaveBeenCalledTimes(1);
    expect(bridge.onPanelKindsChanged).toHaveBeenCalledTimes(1);
  });

  it("re-pulls when panel kinds change", async () => {
    let current: ProjectSurfaceSnapshot = {};
    const bridge = installBridge(() => Promise.resolve(current));

    usePluginProjectSurfacesStore.getState().init();
    await flush();
    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({});

    // A claim can only appear alongside the panel kind it names, so the
    // kinds broadcast is the signal that a surface may have changed too.
    current = { emptyCanvas: claim };
    bridge.listeners[0]?.();
    await flush();

    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("drops a stale pull that resolves after a newer one", async () => {
    const resolvers: Array<(value: ProjectSurfaceSnapshot) => void> = [];
    const bridge = installBridge(
      () => new Promise<ProjectSurfaceSnapshot>((resolve) => resolvers.push(resolve))
    );

    usePluginProjectSurfacesStore.getState().init();
    bridge.listeners[0]?.();

    // Resolve the NEWER pull first, then the stale one. The stale answer must
    // not roll the store back to a snapshot taken before the change.
    resolvers[1]?.({ emptyCanvas: claim });
    await flush();
    resolvers[0]?.({});
    await flush();

    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("stays retryable and empty with no bridge", () => {
    usePluginProjectSurfacesStore.getState().init();
    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({});

    // Not latched: a component test that renders before the bridge exists must
    // not wedge the store for the rest of the session.
    const bridge = installBridge({ emptyCanvas: claim });
    usePluginProjectSurfacesStore.getState().init();
    expect(bridge.getProjectSurfaces).toHaveBeenCalledTimes(1);
  });

  it("leaves the stock surface in place when the pull fails", async () => {
    installBridge(() => Promise.reject(new Error("nope")));

    usePluginProjectSurfacesStore.getState().init();
    await flush();

    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({});
  });

  it("clears a stale claim when a later pull fails", async () => {
    // Keeping the last answer would outlive the plugin that made it: if the
    // same runtime kind id is re-registered later with no claim behind it, the
    // retained snapshot would resurrect a surface main no longer owns.
    let fail = false;
    const bridge = installBridge(() =>
      fail ? Promise.reject(new Error("nope")) : Promise.resolve({ emptyCanvas: claim })
    );

    usePluginProjectSurfacesStore.getState().init();
    await flush();
    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({ emptyCanvas: claim });

    fail = true;
    bridge.listeners[0]?.();
    await flush();

    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({});
  });

  it("does not let a stale failure clear a newer successful pull", async () => {
    const settlers: Array<{ resolve: (v: never) => void; reject: (e: Error) => void }> = [];
    const bridge = installBridge(
      () =>
        new Promise<never>((resolve, reject) => {
          settlers.push({ resolve: resolve as (v: never) => void, reject });
        })
    );

    usePluginProjectSurfacesStore.getState().init();
    bridge.listeners[0]?.();

    settlers[1]?.resolve({ emptyCanvas: claim } as never);
    await flush();
    settlers[0]?.reject(new Error("stale"));
    await flush();

    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("tracks the stock-canvas pin without persisting it", () => {
    expect(usePluginProjectSurfacesStore.getState().stockCanvasPinned).toBe(false);

    usePluginProjectSurfacesStore.getState().setStockCanvasPinned(true);
    expect(usePluginProjectSurfacesStore.getState().stockCanvasPinned).toBe(true);

    // A fresh session starts unpinned — the pin is a "let me at the launcher"
    // gesture for right now, never a stored preference.
    _resetPluginProjectSurfacesStoreForTest();
    expect(usePluginProjectSurfacesStore.getState().stockCanvasPinned).toBe(false);
  });
});
