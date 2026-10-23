// @vitest-environment jsdom
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
  it("init is idempotent — does not double-subscribe", async () => {
    const mod = await load();
    mod.usePluginPanelBadgeStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
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

  it("usePanelBadges selector returns the same frozen empty object for two unknown panels", async () => {
    const { renderHook } = await import("@testing-library/react");
    const mod = await load();
    const a = renderHook(() => mod.usePanelBadges("ghost-1"));
    const b = renderHook(() => mod.usePanelBadges("ghost-2"));
    expect(a.result.current).toEqual({});
    // Stable reference across panels and unrelated updates → no churn re-renders.
    expect(a.result.current).toBe(b.result.current);
    changedCb!({ pluginId: "p1", badges: { other: dot() } });
    a.rerender();
    expect(a.result.current).toBe(b.result.current);
  });

  it("usePanelBadges selector reflects a badge set on its panel", async () => {
    const { renderHook } = await import("@testing-library/react");
    const { act } = await import("@testing-library/react");
    const mod = await load();
    const { result } = renderHook(() => mod.usePanelBadges("panelA"));
    expect(result.current).toEqual({});
    act(() => changedCb!({ pluginId: "p1", badges: { panelA: label("CI") } }));
    expect(result.current).toEqual({ p1: { kind: "label", text: "CI" } });
  });

  it("tolerates an absent bridge and stays retryable once a real bridge appears", async () => {
    const win = globalThis as unknown as {
      window: { electron: { plugin: Record<string, unknown> } };
    };
    win.window.electron.plugin = {}; // no badge subscription methods yet
    const mod = await import("../pluginPanelBadgeStore");
    mod._resetPluginPanelBadgeStoreForTest();
    expect(() => mod.usePluginPanelBadgeStore.getState().init()).not.toThrow();
    expect(onChangedMock).not.toHaveBeenCalled();

    // A later mount with the real bridge present must still subscribe — the
    // absent-bridge early return did not latch `initialized`.
    win.window.electron.plugin = {
      onPanelBadgesChanged: onChangedMock,
      onPanelBadgesCleared: onClearedMock,
    };
    mod.usePluginPanelBadgeStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
    expect(onClearedMock).toHaveBeenCalledTimes(1);
  });

  describe("structural sharing (#14128)", () => {
    const fleet = (n: number, changed?: number): Record<string, PluginPanelBadge> =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`panel-${i}`, i === changed ? label("2") : dot()])
      );

    it("one changed badge in a 100-panel snapshot invalidates only that panel's selector", async () => {
      const mod = await load();
      changedCb!({ pluginId: "p1", badges: fleet(100) });
      const before = { ...mod.usePluginPanelBadgeStore.getState().badgesByPanelId };

      changedCb!({ pluginId: "p1", badges: fleet(100, 42) });

      const after = mod.usePluginPanelBadgeStore.getState().badgesByPanelId;
      const invalidated = Object.keys(before).filter((id) => after[id] !== before[id]);
      expect(invalidated).toEqual(["panel-42"]);
      expect(after["panel-42"]).toEqual({ p1: { kind: "label", text: "2" } });
    });

    it("an equal replay is a store no-op, root notification included", async () => {
      const mod = await load();
      changedCb!({ pluginId: "p1", badges: fleet(100) });
      const root = mod.usePluginPanelBadgeStore.getState().badgesByPanelId;
      const listener = vi.fn();
      const unsubscribe = mod.usePluginPanelBadgeStore.subscribe(listener);

      changedCb!({ pluginId: "p1", badges: fleet(100) });
      clearedCb!({ pluginId: "never-badged" });

      unsubscribe();
      expect(listener).not.toHaveBeenCalled();
      expect(mod.usePluginPanelBadgeStore.getState().badgesByPanelId).toBe(root);
    });

    it("clearing one panel leaves every other panel's object, and another plugin's badge, in place", async () => {
      const mod = await load();
      changedCb!({ pluginId: "p1", badges: fleet(3) });
      changedCb!({ pluginId: "p2", badges: { "panel-0": label("CI") } });
      const before = mod.usePluginPanelBadgeStore.getState().badgesByPanelId;

      const { "panel-0": _cleared, ...rest } = fleet(3);
      changedCb!({ pluginId: "p1", badges: { ...rest, "panel-1": dot() } });

      const after = mod.usePluginPanelBadgeStore.getState().badgesByPanelId;
      expect(after["panel-0"]).toEqual({ p2: { kind: "label", text: "CI" } });
      expect(after["panel-1"]).toBe(before["panel-1"]);
      expect(after["panel-2"]).toBe(before["panel-2"]);
    });

    it("treats an omitted colour as the default one, as main does", async () => {
      const mod = await load();
      changedCb!({ pluginId: "p1", badges: { panelA: dot("default") } });
      const root = mod.usePluginPanelBadgeStore.getState().badgesByPanelId;
      changedCb!({ pluginId: "p1", badges: { panelA: dot() } });
      expect(mod.usePluginPanelBadgeStore.getState().badgesByPanelId).toBe(root);
    });

    it("an unload clear drops the plugin from every panel it badged", async () => {
      const mod = await load();
      changedCb!({ pluginId: "p1", badges: fleet(3) });
      clearedCb!({ pluginId: "p1" });
      expect(mod.usePluginPanelBadgeStore.getState().badgesByPanelId).toEqual({});
    });
  });
});
