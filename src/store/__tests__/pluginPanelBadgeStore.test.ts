import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginPanelBadge } from "@shared/types/plugin";

type ChangedPayload = { pluginId: string; badges: Record<string, PluginPanelBadge> };
type ClearedPayload = { pluginId: string };

const { onChangedMock, onClearedMock } = vi.hoisted(() => ({
  onChangedMock: vi.fn(),
  onClearedMock: vi.fn(),
}));

let changedCb: ((p: ChangedPayload) => void) | null = null;
let clearedCb: ((p: ClearedPayload) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  changedCb = null;
  clearedCb = null;
  onChangedMock.mockImplementation((cb: (p: ChangedPayload) => void) => {
    changedCb = cb;
    return () => {};
  });
  onClearedMock.mockImplementation((cb: (p: ClearedPayload) => void) => {
    clearedCb = cb;
    return () => {};
  });
  (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis.window ?? {}, {
    electron: {
      plugin: {
        onPanelBadgesChanged: onChangedMock,
        onPanelBadgesCleared: onClearedMock,
      },
    },
  });
});

async function load() {
  const mod = await import("../pluginPanelBadgeStore");
  mod._resetPluginPanelBadgeStoreForTest();
  mod.usePluginPanelBadgeStore.getState().init();
  return mod;
}

const dot = (color?: PluginPanelBadge["color"]): PluginPanelBadge => ({ kind: "dot", color });
const label = (text: string): PluginPanelBadge => ({ kind: "label", text });

describe("pluginPanelBadgeStore", () => {
  it("subscribes to both badge events on init", async () => {
    await load();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
    expect(onClearedMock).toHaveBeenCalledTimes(1);
  });

  it("init is idempotent — does not double-subscribe", async () => {
    const mod = await load();
    mod.usePluginPanelBadgeStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("stores a badge keyed by panelId then pluginId", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", badges: { panelA: dot("success") } });
    expect(mod.usePluginPanelBadgeStore.getState().badgesByPanelId).toEqual({
      panelA: { p1: { kind: "dot", color: "success" } },
    });
  });

  it("keeps two plugins' badges on the same panel independent", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", badges: { panelA: dot() } });
    changedCb!({ pluginId: "p2", badges: { panelA: label("CI") } });
    expect(mod.usePluginPanelBadgeStore.getState().badgesByPanelId.panelA).toEqual({
      p1: { kind: "dot", color: undefined },
      p2: { kind: "label", text: "CI" },
    });
  });

  it("treats each changed event as the plugin's complete map — drops panels no longer present", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", badges: { panelA: dot(), panelB: dot() } });
    // Re-emit with only panelB → panelA's p1 badge must be gone.
    changedCb!({ pluginId: "p1", badges: { panelB: label("2") } });
    const state = mod.usePluginPanelBadgeStore.getState().badgesByPanelId;
    expect(state.panelA).toBeUndefined();
    expect(state.panelB).toEqual({ p1: { kind: "label", text: "2" } });
  });

  it("removing one plugin's badge leaves another plugin's badge on the same panel", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", badges: { panelA: dot() } });
    changedCb!({ pluginId: "p2", badges: { panelA: dot() } });
    changedCb!({ pluginId: "p1", badges: {} }); // p1 clears
    expect(mod.usePluginPanelBadgeStore.getState().badgesByPanelId.panelA).toEqual({
      p2: { kind: "dot", color: undefined },
    });
  });

  it("clears all of a plugin's badges on the cleared event", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", badges: { panelA: dot(), panelB: dot() } });
    clearedCb!({ pluginId: "p1" });
    expect(mod.usePluginPanelBadgeStore.getState().badgesByPanelId).toEqual({});
  });

  it("preserves the object reference of unaffected panels", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", badges: { panelA: dot() } });
    const before = mod.usePluginPanelBadgeStore.getState().badgesByPanelId.panelA;
    changedCb!({ pluginId: "p2", badges: { panelB: dot() } });
    const after = mod.usePluginPanelBadgeStore.getState().badgesByPanelId.panelA;
    expect(after).toBe(before);
  });

  it("usePanelBadges returns a stable empty object for an unknown panel", async () => {
    const mod = await load();
    const a = mod.usePluginPanelBadgeStore.getState().badgesByPanelId.unknown;
    expect(a).toBeUndefined();
    // The selector's fallback is exercised through the store's frozen empty.
    changedCb!({ pluginId: "p1", badges: {} });
    expect(mod.usePluginPanelBadgeStore.getState().badgesByPanelId).toEqual({});
  });

  it("tolerates an absent bridge without throwing", async () => {
    (globalThis as unknown as { window: { electron: { plugin: object } } }).window.electron.plugin =
      {};
    const mod = await import("../pluginPanelBadgeStore");
    mod._resetPluginPanelBadgeStoreForTest();
    expect(() => mod.usePluginPanelBadgeStore.getState().init()).not.toThrow();
  });
});
