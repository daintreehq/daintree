// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginPanelSnapshotEntry } from "@/services/plugin/pluginPanelLifecycle";

interface FakePanel {
  kind?: string;
  pluginPanelKindId?: string;
  location?: string;
  title?: string;
  activityStatus?: string;
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
const registryListeners = vi.hoisted(() => new Set<() => void>());
const kindLookups = vi.hoisted(() =>
  vi.fn((id: string) =>
    kinds.has(id) ? { id, extensionId: kinds.get(id) || undefined } : undefined
  )
);
vi.mock("@shared/config/panelKindRegistry", () => ({
  getPanelKindConfig: kindLookups,
  subscribeToPanelKindRegistry: (listener: () => void) => {
    registryListeners.add(listener);
    return () => registryListeners.delete(listener);
  },
}));

const syncMock = vi.hoisted(() =>
  vi.fn<(entries: readonly PluginPanelSnapshotEntry[], live?: ReadonlySet<string>) => void>()
);
vi.mock("@/services/plugin/pluginPanelLifecycle", () => ({ syncPluginPanels: syncMock }));

import { usePluginPanelLifecycle } from "@/hooks/usePluginPanelLifecycle";

const onPanelKindsChanged = vi.fn<(cb: () => void) => () => void>();

beforeEach(() => {
  syncMock.mockClear();
  kindLookups.mockClear();
  registryListeners.clear();
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

  it("reports a PTY-backed plugin panel under the kind it was opened as (#13213)", () => {
    kinds.set("acme.shell", "acme");
    store.state.panelsById = {
      s1: { kind: "terminal", pluginPanelKindId: "acme.shell", location: "grid" },
    };

    renderHook(() => usePluginPanelLifecycle());

    expect(lastCall()[0]).toEqual([
      { panelId: "s1", kindId: "acme.shell", pluginId: "acme", location: "grid" },
    ]);
  });

  it("re-collects when a panel is added", () => {
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

    // Focus and resize churn replaces state but not `panelsById`.
    for (const listener of store.listeners) listener(store.state);

    expect(syncMock).not.toHaveBeenCalled();
  });

  it("re-collects when panel kinds change without any panel-store write", () => {
    store.state.panelsById = { p1: { kind: "acme.dash", location: "grid" } };
    kinds.clear();
    renderHook(() => usePluginPanelLifecycle());
    expect(lastCall()[0]).toHaveLength(0);

    // A plugin finishing its load registers the kind; no panel record moved, so
    // only the registry change can surface the panel.
    kinds.set("acme.dash", "acme");
    expect(registryListeners.size).toBe(1);
    for (const listener of registryListeners) listener();

    expect(lastCall()[0]).toHaveLength(1);
  });

  it("stops collecting after unmount", () => {
    const { unmount } = renderHook(() => usePluginPanelLifecycle());

    unmount();
    syncMock.mockClear();
    store.set({ p1: { kind: "acme.dash", location: "grid" } });

    expect(syncMock).not.toHaveBeenCalled();
    expect(registryListeners.size).toBe(0);
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

describe("structural gating (#14126)", () => {
  const terminals = (n: number): Record<string, FakePanel> => {
    const panels: Record<string, FakePanel> = {};
    for (let i = 0; i < n; i++) panels[`t${i}`] = { kind: "terminal", location: "grid" };
    return panels;
  };

  const churn = (times: number, field: "activityStatus" | "title"): void => {
    const ids = Object.keys(store.state.panelsById).filter((id) => id.startsWith("t"));
    for (let i = 0; i < times; i++) {
      const id = ids[i % ids.length]!;
      store.set({
        ...store.state.panelsById,
        [id]: { ...store.state.panelsById[id], [field]: `${field}-${i}` },
      });
    }
  };

  function mountWithInventory(panels: Record<string, FakePanel>) {
    const reportPanelInventory = vi.fn<(ids: string[]) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: { reportPanelInventory } },
    });
    kinds.set("terminal", "");
    store.state.panelsById = panels;
    renderHook(() => usePluginPanelLifecycle());
    expect(reportPanelInventory).toHaveBeenCalledTimes(1);
    syncMock.mockClear();
    kindLookups.mockClear();
    reportPanelInventory.mockClear();
    return reportPanelInventory;
  }

  it("does no lifecycle work for activity or title churn with no plugin panels", () => {
    const report = mountWithInventory(terminals(100));

    churn(60, "activityStatus");
    churn(60, "title");

    expect(syncMock).not.toHaveBeenCalled();
    expect(kindLookups).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("does no lifecycle work for churn alongside plugin panels", () => {
    const report = mountWithInventory({
      ...terminals(100),
      p1: { kind: "acme.dash", location: "grid" },
      s1: { kind: "terminal", pluginPanelKindId: "acme.dash", location: "dock" },
    });

    churn(60, "activityStatus");
    store.set({ ...store.state.panelsById, p1: { ...store.state.panelsById.p1, title: "x" } });
    // A fresh object carrying the same structural fields is still not a change.
    store.set({ ...store.state.panelsById, s1: { ...store.state.panelsById.s1 } });

    expect(syncMock).not.toHaveBeenCalled();
    expect(kindLookups).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("collects exactly once per structural transition", () => {
    mountWithInventory({ ...terminals(3), p1: { kind: "acme.dash", location: "grid" } });
    const step = (next: Record<string, FakePanel>) => {
      syncMock.mockClear();
      kindLookups.mockClear();
      store.set(next);
      expect(syncMock).toHaveBeenCalledTimes(1);
      expect(kindLookups).toHaveBeenCalledTimes(Object.keys(next).length);
    };
    const current = () => store.state.panelsById;

    step({ ...current(), t9: { kind: "terminal", location: "grid" } });
    const { t9: _gone, ...withoutT9 } = current();
    step(withoutT9);
    step({ ...current(), p1: { ...current().p1, location: "trash" } });
    step({ ...current(), p1: { ...current().p1, location: "grid" } });
    step({ ...current(), t0: { ...current().t0, kind: "acme.dash" } });
    step({ ...current(), t1: { ...current().t1, pluginPanelKindId: "acme.dash" } });
    step({ ...current(), t1: { kind: "terminal", location: "grid" } });
    // Same key count: one panel replaced by another.
    const { t2: _swapped, ...withoutT2 } = current();
    step({ ...withoutT2, t7: { kind: "terminal", location: "grid" } });
    const { t7: _last, ...withoutT7 } = current();
    step(withoutT7);

    // Churn after a structural write still costs nothing: the baseline moved.
    syncMock.mockClear();
    churn(5, "activityStatus");
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("collects on a registry change without asking main for kinds again", () => {
    const getPanelKinds = vi.fn(() => Promise.resolve([]));
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: { getPanelKinds, onPanelKindsChanged } },
    });
    store.state.panelsById = { p1: { kind: "acme.dash", location: "grid" } };
    kinds.clear();
    renderHook(() => usePluginPanelLifecycle());
    expect(lastCall()[0]).toHaveLength(0);

    kinds.set("acme.dash", "acme");
    for (const listener of registryListeners) listener();

    expect(lastCall()[0]).toHaveLength(1);
    // `usePluginPanelKinds` owns the pull; its result reaches us as a registry
    // mutation.
    expect(getPanelKinds).not.toHaveBeenCalled();
    expect(onPanelKindsChanged).not.toHaveBeenCalled();
  });
});

describe("non-plugin panel inventory (#12610)", () => {
  it("reports registered non-plugin panels, and only when that set changes", () => {
    const reportPanelInventory = vi.fn<(ids: string[]) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: { onPanelKindsChanged, reportPanelInventory } },
    });
    // Registered with no plugin — a built-in kind.
    kinds.set("terminal", "");
    store.state.panelsById = {
      p1: { kind: "acme.dash", location: "grid" },
      t2: { kind: "terminal", location: "grid" },
      t1: { kind: "terminal", location: "grid" },
      // Unregistered: may be a plugin kind mid-upgrade, so never called non-plugin.
      u1: { kind: "gone.kind", location: "grid" },
    };

    renderHook(() => usePluginPanelLifecycle());
    expect(reportPanelInventory).toHaveBeenCalledTimes(1);
    expect(reportPanelInventory).toHaveBeenLastCalledWith(["t1", "t2"]);

    // A write that moves a panel but keeps the set says nothing new.
    store.set({ ...store.state.panelsById, t1: { kind: "terminal", location: "dock" } });
    expect(reportPanelInventory).toHaveBeenCalledTimes(1);

    const { t2: _removed, ...rest } = store.state.panelsById;
    store.set(rest);
    expect(reportPanelInventory).toHaveBeenCalledTimes(2);
    expect(reportPanelInventory).toHaveBeenLastCalledWith(["t1"]);
  });

  it("resends an unchanged inventory after a failed report", async () => {
    const reportPanelInventory = vi
      .fn<(ids: string[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("ipc down"))
      .mockResolvedValue(undefined);
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: { onPanelKindsChanged, reportPanelInventory } },
    });
    kinds.set("terminal", "");
    store.state.panelsById = { t1: { kind: "terminal", location: "grid" } };

    renderHook(() => usePluginPanelLifecycle());
    expect(reportPanelInventory).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();

    store.set({ t1: { kind: "terminal", location: "dock" } });
    expect(reportPanelInventory).toHaveBeenCalledTimes(2);
    expect(reportPanelInventory).toHaveBeenLastCalledWith(["t1"]);
  });
});
