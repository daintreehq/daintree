// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginPanelSnapshotEntry } from "@/services/plugin/pluginPanelLifecycle";

interface FakePanel {
  kind?: string;
  location?: string;
}

const store = vi.hoisted(() => {
  const state: { panelsById: Record<string, FakePanel> } = { panelsById: {} };
  const listeners = new Set<(s: typeof state) => void>();
  return {
    state,
    listeners,
    set(panelsById: Record<string, FakePanel>) {
      state.panelsById = panelsById;
      for (const l of [...listeners]) l(state);
    },
  };
});

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => store.state,
    subscribe: (listener: (s: typeof store.state) => void) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
  },
}));

const kinds = vi.hoisted(() => new Map<string, string>());
vi.mock("@shared/config/panelKindRegistry", () => ({
  getPanelKindConfig: (id: string) =>
    kinds.has(id) ? { id, extensionId: kinds.get(id) } : undefined,
}));

const syncMock = vi.hoisted(() =>
  vi.fn<(entries: readonly PluginPanelSnapshotEntry[], live?: ReadonlySet<string>) => void>()
);
vi.mock("@/services/plugin/pluginPanelLifecycle", () => ({ syncPluginPanels: syncMock }));

import { usePluginPanelLifecycle } from "@/hooks/usePluginPanelLifecycle";

const onPanelKindsChanged = vi.fn<(cb: () => void) => () => void>();

beforeEach(() => {
  syncMock.mockClear();
  kinds.clear();
  kinds.set("acme.dash", "acme");
  store.state.panelsById = {};
  store.listeners.clear();
  onPanelKindsChanged.mockReset();
  onPanelKindsChanged.mockReturnValue(() => {});
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: { onPanelKindsChanged } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastCall = () => syncMock.mock.calls[syncMock.mock.calls.length - 1]!;

describe("usePluginPanelLifecycle", () => {
  it("reports only plugin-owned panels but counts every panel as live", () => {
    store.state.panelsById = {
      p1: { kind: "acme.dash", location: "grid" },
      t1: { kind: "terminal", location: "grid" },
    };

    renderHook(() => usePluginPanelLifecycle());

    const [entries, live] = lastCall();
    expect(entries).toEqual([
      { panelId: "p1", kindId: "acme.dash", pluginId: "acme", location: "grid" },
    ]);
    // Liveness must span non-plugin panels too — it is what decides permanent
    // removal, and a built-in panel's presence says the store is populated.
    expect([...(live ?? [])].sort()).toEqual(["p1", "t1"]);
  });

  it("re-collects when the panel map changes identity", () => {
    renderHook(() => usePluginPanelLifecycle());
    syncMock.mockClear();

    store.set({ p1: { kind: "acme.dash", location: "grid" } });

    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(lastCall()[0]).toHaveLength(1);
  });

  it("skips store writes that leave the panel map identical", () => {
    store.state.panelsById = { p1: { kind: "acme.dash", location: "grid" } };
    renderHook(() => usePluginPanelLifecycle());
    syncMock.mockClear();

    // Focus/title/resize churn replaces state but not `panelsById` — rescanning
    // every panel on each of those would be pure waste.
    for (const listener of store.listeners) listener(store.state);

    expect(syncMock).not.toHaveBeenCalled();
  });

  it("re-collects when panel kinds change without any panel-store write", () => {
    store.state.panelsById = { p1: { kind: "acme.dash", location: "grid" } };
    kinds.clear();
    renderHook(() => usePluginPanelLifecycle());
    expect(lastCall()[0]).toHaveLength(0);

    // A plugin finishing its load registers the kind; no panel record moved, so
    // only the kind broadcast can surface the panel.
    kinds.set("acme.dash", "acme");
    const emit = onPanelKindsChanged.mock.calls[0]?.[0];
    expect(emit).toBeTypeOf("function");
    emit!();

    expect(lastCall()[0]).toHaveLength(1);
  });

  it("stops collecting after unmount", () => {
    const stopKinds = vi.fn();
    onPanelKindsChanged.mockReturnValue(stopKinds);
    const { unmount } = renderHook(() => usePluginPanelLifecycle());

    unmount();
    syncMock.mockClear();
    store.set({ p1: { kind: "acme.dash", location: "grid" } });

    expect(syncMock).not.toHaveBeenCalled();
    expect(stopKinds).toHaveBeenCalledTimes(1);
  });

  it("works without a plugin bridge", () => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    expect(() => renderHook(() => usePluginPanelLifecycle())).not.toThrow();
    expect(syncMock).toHaveBeenCalled();
  });
});
