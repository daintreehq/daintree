// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PublishedPanelMenuItem } from "@shared/utils/pluginPanelMenuItems";

type ChangedPayload = {
  pluginId: string;
  menus: Record<string, readonly PublishedPanelMenuItem[]>;
};

const { onChangedMock } = vi.hoisted(() => ({
  onChangedMock: vi.fn(),
}));

let changedCb: ((p: ChangedPayload) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  changedCb = null;
  onChangedMock.mockImplementation((cb: (p: ChangedPayload) => void) => {
    changedCb = cb;
    return () => {};
  });
  (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis.window ?? {}, {
    electron: {
      plugin: {
        onPanelMenusChanged: onChangedMock,
      },
    },
  });
});

const worker = (mod: Awaited<ReturnType<typeof load>>, panelId: string) =>
  mod.usePluginPanelMenuStore.getState().workerMenusByPanelId[panelId];
const view = (mod: Awaited<ReturnType<typeof load>>, panelId: string) =>
  mod.usePluginPanelMenuStore.getState().viewMenusByPanelId[panelId];

async function load() {
  const mod = await import("../pluginPanelMenuStore");
  mod._resetPluginPanelMenuStoreForTest();
  mod.usePluginPanelMenuStore.getState().init();
  return mod;
}

const open = { actionId: "acme.open" };
const exportCsv = { actionId: "acme.export", label: "CSV" };

describe("pluginPanelMenuStore", () => {
  it("subscribes once, however often init runs", async () => {
    const mod = await load();
    mod.usePluginPanelMenuStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("stays retryable while the bridge is missing", async () => {
    const mod = await import("../pluginPanelMenuStore");
    mod._resetPluginPanelMenuStoreForTest();
    (globalThis as unknown as { window: { electron?: unknown } }).window.electron = {};
    mod.usePluginPanelMenuStore.getState().init();
    (globalThis as unknown as { window: { electron?: unknown } }).window.electron = {
      plugin: { onPanelMenusChanged: onChangedMock },
    };
    mod.usePluginPanelMenuStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("treats each backend event as the plugin's complete map", async () => {
    const mod = await load();
    changedCb!({ pluginId: "acme", menus: { panelA: [open], panelB: [exportCsv] } });
    changedCb!({ pluginId: "acme", menus: { panelB: [open] } });
    expect(worker(mod, "panelA")).toBeUndefined();
    expect(worker(mod, "panelB")).toEqual({ acme: [open] });
  });

  it("keeps two plugins' lists on one panel apart, and clears one on its empty map", async () => {
    const mod = await load();
    changedCb!({ pluginId: "acme", menus: { panelA: [open] } });
    changedCb!({ pluginId: "other", menus: { panelA: [exportCsv] } });
    changedCb!({ pluginId: "acme", menus: {} });
    expect(worker(mod, "panelA")).toEqual({ other: [exportCsv] });
  });

  it("keeps the store untouched when a republish changes nothing", async () => {
    const mod = await load();
    changedCb!({ pluginId: "acme", menus: { panelA: [open] } });
    const before = mod.usePluginPanelMenuStore.getState().workerMenusByPanelId;
    changedCb!({ pluginId: "acme", menus: { panelA: [{ actionId: "acme.open" }] } });
    expect(mod.usePluginPanelMenuStore.getState().workerMenusByPanelId).toBe(before);
  });

  it("holds the view's list apart from the backend's", async () => {
    const mod = await load();
    changedCb!({ pluginId: "acme", menus: { panelA: [open] } });
    mod.usePluginPanelMenuStore.getState().setViewItems("panelA", [exportCsv]);
    expect(view(mod, "panelA")).toEqual([exportCsv]);
    expect(worker(mod, "panelA")).toEqual({ acme: [open] });

    mod.usePluginPanelMenuStore.getState().setViewItems("panelA", []);
    expect(view(mod, "panelA")).toBeUndefined();
    expect(worker(mod, "panelA")).toEqual({ acme: [open] });
  });

  it("drops every list on a closed panel and nothing on another", async () => {
    const mod = await load();
    changedCb!({ pluginId: "acme", menus: { panelA: [open], panelB: [open] } });
    mod.usePluginPanelMenuStore.getState().setViewItems("panelA", [exportCsv]);
    mod.usePluginPanelMenuStore.getState().removePanel("panelA");
    expect(worker(mod, "panelA")).toBeUndefined();
    expect(view(mod, "panelA")).toBeUndefined();
    expect(worker(mod, "panelB")).toEqual({ acme: [open] });

    const before = mod.usePluginPanelMenuStore.getState();
    mod.usePluginPanelMenuStore.getState().removePanel("missing");
    expect(mod.usePluginPanelMenuStore.getState()).toBe(before);
  });
});
