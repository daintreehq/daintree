// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginToolbarButtonRuntimeState } from "@shared/types/plugin";

type ChangedPayload = { pluginId: string; states: Record<string, PluginToolbarButtonRuntimeState> };

const { onChangedMock } = vi.hoisted(() => ({ onChangedMock: vi.fn() }));

let changedCb: ((p: ChangedPayload) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  changedCb = null;
  onChangedMock.mockImplementation((cb: (p: ChangedPayload) => void) => {
    changedCb = cb;
    return () => {};
  });
  Reflect.set(window, "electron", { plugin: { onToolbarStatesChanged: onChangedMock } });
});

async function load() {
  const mod = await import("../pluginToolbarStateStore");
  mod._resetPluginToolbarStateStoreForTest();
  mod.usePluginToolbarStateStore.getState().init();
  return mod;
}

describe("pluginToolbarStateStore", () => {
  it("init is idempotent", async () => {
    const mod = await load();
    mod.usePluginToolbarStateStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("stays retryable while the bridge is missing", async () => {
    Reflect.set(window, "electron", {});
    const mod = await import("../pluginToolbarStateStore");
    mod._resetPluginToolbarStateStoreForTest();
    mod.usePluginToolbarStateStore.getState().init();
    Reflect.set(window, "electron", { plugin: { onToolbarStatesChanged: onChangedMock } });
    mod.usePluginToolbarStateStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("replaces one plugin's map wholesale and leaves others alone", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", states: { a: { pressed: true }, b: { busy: true } } });
    changedCb!({ pluginId: "p2", states: { a: { pressed: false } } });
    const p2Before = mod.usePluginToolbarStateStore.getState().statesByPlugin.p2;
    changedCb!({ pluginId: "p1", states: { b: { tooltip: "Synced" } } });

    const state = mod.usePluginToolbarStateStore.getState().statesByPlugin;
    expect(state.p1).toEqual({ b: { tooltip: "Synced" } });
    expect(state.p2).toBe(p2Before);
  });

  it("drops a plugin on an empty map, and an empty map for an unknown plugin changes nothing", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", states: { a: { busy: true } } });
    changedCb!({ pluginId: "p1", states: {} });
    expect(mod.usePluginToolbarStateStore.getState().statesByPlugin).toEqual({});

    const before = mod.usePluginToolbarStateStore.getState();
    changedCb!({ pluginId: "ghost", states: {} });
    expect(mod.usePluginToolbarStateStore.getState()).toBe(before);
  });

  it("resolves a canonical button id by its owning plugin's prefix, even with a dotted plugin id", async () => {
    const mod = await load();
    changedCb!({ pluginId: "acme.beads", states: { sync: { pressed: true } } });
    const { statesByPlugin } = mod.usePluginToolbarStateStore.getState();

    expect(
      mod.toolbarStateFor(statesByPlugin, { id: "acme.beads.sync", pluginId: "acme.beads" })
    ).toEqual({ pressed: true });
    expect(
      mod.toolbarStateFor(statesByPlugin, { id: "acme.beads.sync", pluginId: "acme" })
    ).toBeNull();
    expect(mod.toolbarStateFor(statesByPlugin, { id: "other.sync", pluginId: "" })).toBeNull();
  });
});
