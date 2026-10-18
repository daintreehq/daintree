// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginPanelBadge } from "@shared/types/plugin";

type ChangedPayload = { pluginId: string; badges: Record<string, PluginPanelBadge> };

const { onChangedMock } = vi.hoisted(() => ({ onChangedMock: vi.fn() }));

let changedCb: ((p: ChangedPayload) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  changedCb = null;
  onChangedMock.mockImplementation((cb: (p: ChangedPayload) => void) => {
    changedCb = cb;
    return () => {};
  });
  Reflect.set(window, "electron", { plugin: { onToolbarBadgesChanged: onChangedMock } });
});

async function load() {
  const mod = await import("../pluginToolbarBadgeStore");
  mod._resetPluginToolbarBadgeStoreForTest();
  mod.usePluginToolbarBadgeStore.getState().init();
  return mod;
}

const count = (text: string): PluginPanelBadge => ({ kind: "label", text });

describe("pluginToolbarBadgeStore", () => {
  it("init is idempotent", async () => {
    const mod = await load();
    mod.usePluginToolbarBadgeStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("stays retryable while the bridge is missing", async () => {
    Reflect.set(window, "electron", {});
    const mod = await import("../pluginToolbarBadgeStore");
    mod._resetPluginToolbarBadgeStoreForTest();
    mod.usePluginToolbarBadgeStore.getState().init();
    Reflect.set(window, "electron", { plugin: { onToolbarBadgesChanged: onChangedMock } });
    mod.usePluginToolbarBadgeStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("replaces one plugin's map wholesale and leaves others alone", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", badges: { a: count("1"), b: count("2") } });
    changedCb!({ pluginId: "p2", badges: { a: count("7") } });
    const p2Before = mod.usePluginToolbarBadgeStore.getState().badgesByPlugin.p2;
    changedCb!({ pluginId: "p1", badges: { b: count("3") } });

    const state = mod.usePluginToolbarBadgeStore.getState().badgesByPlugin;
    expect(state.p1).toEqual({ b: count("3") });
    expect(state.p2).toBe(p2Before);
  });

  it("drops a plugin on an empty map, and an empty map for an unknown plugin changes nothing", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", badges: { a: count("1") } });
    changedCb!({ pluginId: "p1", badges: {} });
    expect(mod.usePluginToolbarBadgeStore.getState().badgesByPlugin).toEqual({});

    const before = mod.usePluginToolbarBadgeStore.getState();
    changedCb!({ pluginId: "ghost", badges: {} });
    expect(mod.usePluginToolbarBadgeStore.getState()).toBe(before);
  });

  it("resolves a canonical button id by its owning plugin's prefix, even with a dotted plugin id", async () => {
    const mod = await load();
    changedCb!({ pluginId: "acme.beads", badges: { needs: count("4") } });
    const { badgesByPlugin } = mod.usePluginToolbarBadgeStore.getState();

    expect(
      mod.toolbarBadgeFor(badgesByPlugin, { id: "acme.beads.needs", pluginId: "acme.beads" })
    ).toEqual(count("4"));
    // Another plugin whose id shares a prefix never reads this one's badge.
    expect(
      mod.toolbarBadgeFor(badgesByPlugin, { id: "acme.beads.needs", pluginId: "acme" })
    ).toBeNull();
    expect(
      mod.toolbarBadgeFor(badgesByPlugin, { id: "acme.beads.other", pluginId: "acme.beads" })
    ).toBeNull();
  });
});
