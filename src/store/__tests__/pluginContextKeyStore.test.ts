// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginContextValue } from "@shared/types/plugin";
import { evaluate, parse } from "@shared/utils/whenClause";

type ChangedPayload = { pluginId: string; keys: Record<string, PluginContextValue> | null };

const { onChangedMock } = vi.hoisted(() => ({ onChangedMock: vi.fn() }));

let changedCb: ((p: ChangedPayload) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  changedCb = null;
  onChangedMock.mockImplementation((cb: (p: ChangedPayload) => void) => {
    changedCb = cb;
    return () => {};
  });
  Reflect.set(window, "electron", { plugin: { onContextKeysChanged: onChangedMock } });
});

async function load() {
  const mod = await import("../pluginContextKeyStore");
  mod._resetPluginContextKeyStoreForTest();
  mod.usePluginContextKeyStore.getState().init();
  return mod;
}

describe("pluginContextKeyStore", () => {
  it("init is idempotent", async () => {
    const mod = await load();
    mod.usePluginContextKeyStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("stays retryable while the bridge is missing", async () => {
    Reflect.set(window, "electron", {});
    const mod = await import("../pluginContextKeyStore");
    mod._resetPluginContextKeyStoreForTest();
    mod.usePluginContextKeyStore.getState().init();
    Reflect.set(window, "electron", { plugin: { onContextKeysChanged: onChangedMock } });
    mod.usePluginContextKeyStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("replaces one plugin's keys wholesale and rebuilds the nested when context", async () => {
    const mod = await load();
    changedCb!({ pluginId: "acme.beads", keys: { needsYou: true, view: "triage" } });
    changedCb!({ pluginId: "acme.other", keys: { on: true } });
    changedCb!({ pluginId: "acme.beads", keys: { view: "queue" } });

    const { keysByPlugin, whenContext } = mod.usePluginContextKeyStore.getState();
    expect(keysByPlugin["acme.beads"]).toEqual({ view: "queue" });
    expect(evaluate(parse("acme.beads.needsYou"), whenContext)).toBe(false);
    expect(evaluate(parse("acme.beads.view == 'queue' && acme.other.on"), whenContext)).toBe(true);
  });

  it("keeps an emptied plugin and drops it only on null", async () => {
    const mod = await load();
    changedCb!({ pluginId: "acme.beads", keys: { a: true } });
    changedCb!({ pluginId: "acme.beads", keys: {} });
    expect(mod.usePluginContextKeyStore.getState().keysByPlugin).toEqual({ "acme.beads": {} });

    changedCb!({ pluginId: "acme.beads", keys: null });
    expect(mod.usePluginContextKeyStore.getState().keysByPlugin).toEqual({});
  });

  it("leaves state untouched when an unknown plugin unloads", async () => {
    const mod = await load();
    changedCb!({ pluginId: "acme.beads", keys: { a: true } });
    const before = mod.usePluginContextKeyStore.getState();
    changedCb!({ pluginId: "acme.never", keys: null });
    const after = mod.usePluginContextKeyStore.getState();
    expect(after.keysByPlugin).toBe(before.keysByPlugin);
    expect(after.whenContext).toBe(before.whenContext);
  });
});
