// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

import {
  MAX_PLUGIN_VIEW_STATE_ENTRIES,
  PLUGIN_VIEW_STATE_KEY_PREFIX,
  persistPluginViewState,
  pluginViewStateKey,
  readPluginViewState,
  type PluginViewStateIdentity,
} from "../pluginViewStateStore";
import { MAX_EXTENSION_STATE_BYTES } from "@shared/utils/extensionState";

const id = (overrides: Partial<PluginViewStateIdentity> = {}): PluginViewStateIdentity => ({
  hostId: "local",
  workspaceId: "p1",
  pluginId: "acme.tools",
  host: "surface",
  viewKey: "surface:acme/home",
  ...overrides,
});

function storedKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(PLUGIN_VIEW_STATE_KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

function quotaError(): DOMException {
  return new DOMException("The quota has been exceeded.", "QuotaExceededError");
}

describe("pluginViewStateStore", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.clear();
  });

  it("reads nothing for a view that never persisted", () => {
    expect(readPluginViewState(id(), undefined)).toBeNull();
  });

  it("merges patches, removes undefined keys, and reads the bag back canonically", () => {
    expect(persistPluginViewState(id(), { a: 1, b: "two" }, undefined)).toBe(true);
    expect(persistPluginViewState(id(), { b: undefined, when: new Date(0) }, undefined)).toBe(true);
    expect(readPluginViewState(id(), undefined)).toEqual({
      ok: true,
      state: { a: 1, when: "1970-01-01T00:00:00.000Z" },
      version: 0,
    });
  });

  it("keeps every part of the identity apart", () => {
    persistPluginViewState(id(), { who: "base" }, undefined);
    for (const other of [
      id({ hostId: "remote-1" }),
      id({ workspaceId: "p2" }),
      id({ pluginId: "acme.other" }),
      id({ host: "sidebar" }),
      id({ viewKey: "surface:acme/other" }),
    ]) {
      expect(readPluginViewState(other, undefined)).toBeNull();
    }
    expect(readPluginViewState(id(), undefined)).toMatchObject({ state: { who: "base" } });
  });

  it("cannot be confused by separators inside an identity part", () => {
    persistPluginViewState(id({ workspaceId: "a:b", pluginId: "c" }), { x: 1 }, undefined);
    expect(readPluginViewState(id({ workspaceId: "a", pluginId: "b:c" }), undefined)).toBeNull();
  });

  it("refuses a value that is not JSON or is over the cap, leaving the bag as it was", () => {
    persistPluginViewState(id(), { keep: true }, undefined);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(persistPluginViewState(id(), { cyclic }, undefined)).toBe(false);
    expect(
      persistPluginViewState(id(), { big: "x".repeat(MAX_EXTENSION_STATE_BYTES + 1) }, undefined)
    ).toBe(false);
    expect(readPluginViewState(id(), undefined)).toMatchObject({ state: { keep: true } });
  });

  it("stamps the declared version and hands an older bag over for migration", () => {
    persistPluginViewState(id(), { v1: true }, 1);
    expect(readPluginViewState(id(), 2)).toEqual({ ok: true, state: { v1: true }, version: 1 });
    persistPluginViewState(id(), { v2: true }, 2);
    expect(readPluginViewState(id(), 2)).toMatchObject({ version: 2 });
  });

  it("withholds a bag a newer build of the plugin wrote, and never overwrites it", () => {
    persistPluginViewState(id(), { future: true }, 3);
    expect(readPluginViewState(id(), 2)).toMatchObject({
      ok: false,
      reason: "future-version",
      persistedVersion: 3,
      declaredVersion: 2,
    });
    expect(persistPluginViewState(id(), { future: false }, 2)).toBe(false);
    expect(readPluginViewState(id(), 3)).toMatchObject({ ok: true, state: { future: true } });
  });

  it("drops an unreadable entry rather than letting it block the view", () => {
    localStorage.setItem(pluginViewStateKey(id()), "{not json");
    expect(readPluginViewState(id(), undefined)).toBeNull();
    expect(localStorage.getItem(pluginViewStateKey(id()))).toBeNull();
    expect(persistPluginViewState(id(), { fresh: 1 }, undefined)).toBe(true);
  });

  it("leaves an entry a newer app wrote alone", () => {
    const raw = JSON.stringify({ schema: 99, savedAt: 1, state: { x: 1 } });
    localStorage.setItem(pluginViewStateKey(id()), raw);
    expect(readPluginViewState(id(), undefined)).toBeNull();
    expect(persistPluginViewState(id(), { x: 2 }, undefined)).toBe(false);
    expect(localStorage.getItem(pluginViewStateKey(id()))).toBe(raw);
  });

  it("drops the least recently written bags beyond the cap, never the one being written", () => {
    vi.useFakeTimers();
    for (let i = 0; i < MAX_PLUGIN_VIEW_STATE_ENTRIES; i++) {
      vi.setSystemTime(1_000 + i);
      persistPluginViewState(id({ viewKey: `v${i}` }), { i }, undefined);
    }
    // Rewriting the oldest makes it the newest.
    vi.setSystemTime(10_000);
    persistPluginViewState(id({ viewKey: "v0" }), { i: "again" }, undefined);
    vi.setSystemTime(10_001);
    persistPluginViewState(id({ viewKey: "new" }), { i: "new" }, undefined);

    expect(storedKeys()).toHaveLength(MAX_PLUGIN_VIEW_STATE_ENTRIES);
    expect(readPluginViewState(id({ viewKey: "v1" }), undefined)).toBeNull();
    expect(readPluginViewState(id({ viewKey: "v0" }), undefined)).not.toBeNull();
    expect(readPluginViewState(id({ viewKey: "new" }), undefined)).not.toBeNull();
  });

  it("makes room when the quota refuses a write, dropping only plugin view bags", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1);
    persistPluginViewState(id({ viewKey: "old" }), { old: true }, undefined);
    vi.setSystemTime(2);
    persistPluginViewState(id({ viewKey: "newer" }), { newer: true }, undefined);
    localStorage.setItem("someone-else", "kept");

    const realSetItem = Storage.prototype.setItem;
    let refusals = 1;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith(PLUGIN_VIEW_STATE_KEY_PREFIX) && refusals-- > 0) throw quotaError();
      realSetItem.call(this, key, value);
    });

    vi.setSystemTime(3);
    expect(persistPluginViewState(id(), { draft: "kept" }, undefined)).toBe(true);
    expect(readPluginViewState(id({ viewKey: "old" }), undefined)).toBeNull();
    expect(readPluginViewState(id({ viewKey: "newer" }), undefined)).not.toBeNull();
    expect(localStorage.getItem("someone-else")).toBe("kept");
    expect(readPluginViewState(id(), undefined)).toMatchObject({ state: { draft: "kept" } });
  });

  it("reports a write storage would not take even with nothing left to drop", () => {
    persistPluginViewState(id(), { before: true }, undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw quotaError();
    });
    expect(persistPluginViewState(id(), { after: true }, undefined)).toBe(false);
    vi.restoreAllMocks();
    // The refused write never half-landed.
    expect(readPluginViewState(id(), undefined)).toMatchObject({ state: { before: true } });
  });

  it("reports failure rather than throwing when storage is unavailable", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(persistPluginViewState(id(), { x: 1 }, undefined)).toBe(false);
    expect(readPluginViewState(id(), undefined)).toBeNull();
  });

  it("survives a fresh module, as after a restart", async () => {
    persistPluginViewState(id(), { draft: "before restart" }, undefined);
    vi.resetModules();
    const fresh = await import("../pluginViewStateStore");
    expect(fresh.readPluginViewState(id(), undefined)).toMatchObject({
      state: { draft: "before restart" },
    });
  });
});
