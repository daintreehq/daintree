// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHostedViewDescriptor } from "@shared/types/plugin";
import {
  _resetPluginHostedViewsStoreForTest,
  selectPluginHostedView,
  usePluginHostedViewsStore,
} from "../pluginHostedViewsStore";

function view(pluginId: string, componentPath = `plugin://${pluginId}/prefs.js`) {
  return {
    id: `plugin-view:${pluginId}/prefs`,
    pluginId,
    viewId: "prefs",
    location: "settings",
    name: `${pluginId} settings`,
    componentPath,
  } satisfies PluginHostedViewDescriptor;
}

type Listener = (payload: { views: PluginHostedViewDescriptor[] }) => void;

let listeners: Set<Listener>;
let resolvePull: (views: PluginHostedViewDescriptor[]) => void;
let rejectPull: (err: unknown) => void;
let bridge: {
  getHostedViews: ReturnType<typeof vi.fn>;
  onHostedViewsChanged: ReturnType<typeof vi.fn>;
};

function push(views: PluginHostedViewDescriptor[]) {
  listeners.forEach((cb) => cb({ views }));
}

function setBridge(value: unknown) {
  Object.defineProperty(window, "electron", { configurable: true, writable: true, value });
}

beforeEach(() => {
  listeners = new Set();
  bridge = {
    getHostedViews: vi.fn(
      () =>
        new Promise<PluginHostedViewDescriptor[]>((resolve, reject) => {
          resolvePull = resolve;
          rejectPull = reject;
        })
    ),
    onHostedViewsChanged: vi.fn((cb: Listener) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
  };
  setBridge({ plugin: bridge });
  _resetPluginHostedViewsStoreForTest();
});

afterEach(() => {
  _resetPluginHostedViewsStoreForTest();
});

describe("pluginHostedViewsStore", () => {
  it("subscribes before it pulls, and fills from the pull", async () => {
    usePluginHostedViewsStore.getState().init();
    expect(bridge.onHostedViewsChanged.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.getHostedViews.mock.invocationCallOrder[0]
    );
    expect(usePluginHostedViewsStore.getState().views).toBeNull();

    resolvePull([view("acme.a")]);
    await vi.waitFor(() =>
      expect(usePluginHostedViewsStore.getState().views).toEqual([view("acme.a")])
    );
  });

  it("keeps a push over the pull that was answered before it", async () => {
    usePluginHostedViewsStore.getState().init();
    push([view("acme.a", "plugin://a/__dtv-2/prefs.js")]);
    resolvePull([view("acme.a", "plugin://a/__dtv-1/prefs.js")]);
    await Promise.resolve();
    await Promise.resolve();

    expect(usePluginHostedViewsStore.getState().views).toEqual([
      view("acme.a", "plugin://a/__dtv-2/prefs.js"),
    ]);
  });

  it("replaces the snapshot wholesale, so a withdrawn view is gone", () => {
    usePluginHostedViewsStore.getState().init();
    push([view("acme.a"), view("acme.b")]);
    push([view("acme.b")]);
    expect(usePluginHostedViewsStore.getState().views).toEqual([view("acme.b")]);
  });

  it("subscribes once however many homes initialise it", () => {
    usePluginHostedViewsStore.getState().init();
    usePluginHostedViewsStore.getState().init();
    expect(bridge.onHostedViewsChanged).toHaveBeenCalledTimes(1);
    expect(bridge.getHostedViews).toHaveBeenCalledTimes(1);
  });

  it("reports a failed pull as failed, not as nothing served, and retries on the next init", async () => {
    usePluginHostedViewsStore.getState().init();
    rejectPull(new Error("ipc down"));
    await vi.waitFor(() => expect(usePluginHostedViewsStore.getState().loadFailed).toBe(true));
    expect(usePluginHostedViewsStore.getState().views).toBeNull();
    // Released, so the retry doesn't stack a second subscription on the first.
    expect(listeners.size).toBe(0);

    usePluginHostedViewsStore.getState().init();
    expect(usePluginHostedViewsStore.getState().loadFailed).toBe(false);
    expect(bridge.getHostedViews).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(1);
    resolvePull([view("acme.a")]);
    await vi.waitFor(() =>
      expect(usePluginHostedViewsStore.getState().views).toEqual([view("acme.a")])
    );
  });

  it("lets a push that beat the failure stand", async () => {
    usePluginHostedViewsStore.getState().init();
    push([view("acme.a")]);
    rejectPull(new Error("ipc down"));
    await Promise.resolve();
    await Promise.resolve();
    expect(usePluginHostedViewsStore.getState().views).toEqual([view("acme.a")]);
    expect(usePluginHostedViewsStore.getState().loadFailed).toBe(false);
  });

  it("drops a pull that resolves after a reset", async () => {
    usePluginHostedViewsStore.getState().init();
    const stale = resolvePull;
    _resetPluginHostedViewsStoreForTest();
    stale([view("acme.a")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(usePluginHostedViewsStore.getState().views).toBeNull();
  });

  it("stays retryable when the bridge isn't there yet", () => {
    setBridge({});
    usePluginHostedViewsStore.getState().init();
    setBridge({ plugin: bridge });
    usePluginHostedViewsStore.getState().init();
    expect(bridge.onHostedViewsChanged).toHaveBeenCalledTimes(1);
  });
});

describe("selectPluginHostedView", () => {
  it("finds a plugin's view by location, and nothing before the first snapshot", () => {
    const views = [view("acme.a"), view("acme.b")];
    expect(selectPluginHostedView(views, "acme.b", "settings")).toEqual(view("acme.b"));
    expect(selectPluginHostedView(views, "acme.c", "settings")).toBeUndefined();
    expect(selectPluginHostedView(null, "acme.a", "settings")).toBeUndefined();
  });
});
