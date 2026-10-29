// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetPluginPanelLifecycleForTests,
  setViewUnsavedChanges,
  syncPluginPanels,
} from "@/services/plugin/pluginPanelLifecycle";

interface FakePanel {
  title?: string;
}

const store = vi.hoisted(() => {
  type State = { panelsById: Record<string, FakePanel> };
  let state: State = { panelsById: {} };
  const listeners = new Set<(next: State, prev: State) => void>();
  return {
    getState: vi.fn(() => state),
    listeners,
    set(panelsById: Record<string, FakePanel>) {
      const prev = state;
      state = { panelsById };
      for (const listener of [...listeners]) listener(state, prev);
    },
  };
});

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => store.getState(),
    subscribe: (listener: Parameters<typeof store.listeners.add>[0]) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
  },
}));

import { usePluginUnsavedPanelsReporter } from "../usePluginUnsavedPanelsReporter";

const report = vi.fn<(panels: unknown[]) => Promise<void>>();

function track(panelId: string, pluginId = "acme.demo") {
  syncPluginPanels([{ panelId, kindId: `${pluginId}.view`, pluginId, location: "grid" }]);
}

describe("usePluginUnsavedPanelsReporter", () => {
  beforeEach(() => {
    report.mockReset();
    report.mockResolvedValue(undefined);
    resetPluginPanelLifecycleForTests();
    store.listeners.clear();
    store.set({});
    Object.assign(window, { electron: { plugin: { reportUnsavedPanels: report } } });
  });

  it("sends one empty report on mount, then nothing and no reads while nothing is dirty", () => {
    renderHook(() => usePluginUnsavedPanelsReporter());
    expect(report.mock.calls).toEqual([[[]]]);
    const reads = store.getState.mock.calls.length;

    track("p1");
    store.set({ p1: { title: "Draft" } });
    store.set({ p1: { title: "Renamed" } });

    expect(report).toHaveBeenCalledTimes(1);
    expect(store.getState.mock.calls.length).toBe(reads);
  });

  it("reports a panel that turns dirty, and an empty list once it is clean", () => {
    const owner = {};
    track("p1");
    store.set({ p1: { title: "  Invoice draft " } });
    renderHook(() => usePluginUnsavedPanelsReporter());

    setViewUnsavedChanges("p1", owner, true);
    expect(report).toHaveBeenLastCalledWith([
      { panelId: "p1", pluginId: "acme.demo", title: "Invoice draft" },
    ]);

    setViewUnsavedChanges("p1", owner, false);
    expect(report).toHaveBeenLastCalledWith([]);
    expect(report).toHaveBeenCalledTimes(3);
  });

  it("names a view with no panel record by the name it raised the flag with", () => {
    renderHook(() => usePluginUnsavedPanelsReporter());
    setViewUnsavedChanges("sidebar:acme", {}, true, {
      pluginId: "acme.demo",
      displayName: "Acme tasks",
    });

    expect(report).toHaveBeenLastCalledWith([
      { panelId: "sidebar:acme", pluginId: "acme.demo", title: "Acme tasks" },
    ]);
  });

  it("prefers a panel's own title to the view's name", () => {
    store.set({ p1: { title: "Invoice draft" } });
    renderHook(() => usePluginUnsavedPanelsReporter());
    setViewUnsavedChanges("p1", {}, true, { pluginId: "acme.demo", displayName: "Acme" });

    expect(report).toHaveBeenLastCalledWith([
      { panelId: "p1", pluginId: "acme.demo", title: "Invoice draft" },
    ]);
  });

  it("reports again when a dirty panel is renamed, but not for unrelated writes", () => {
    track("p1");
    store.set({ p1: { title: "Draft" }, p2: { title: "Terminal" } });
    renderHook(() => usePluginUnsavedPanelsReporter());
    setViewUnsavedChanges("p1", {}, true);
    expect(report).toHaveBeenCalledTimes(2);

    store.set({ p1: { title: "Draft" }, p2: { title: "Terminal 2" } });
    expect(report).toHaveBeenCalledTimes(2);

    store.set({ p1: { title: "Final draft" }, p2: { title: "Terminal 2" } });
    expect(report).toHaveBeenLastCalledWith([
      { panelId: "p1", pluginId: "acme.demo", title: "Final draft" },
    ]);
  });

  it("reports a view that mounts with a panel already dirty", () => {
    track("p1", "other.plugin");
    store.set({ p1: { title: "Draft" } });
    setViewUnsavedChanges("p1", {}, true);

    renderHook(() => usePluginUnsavedPanelsReporter());

    expect(report).toHaveBeenCalledWith([
      { panelId: "p1", pluginId: "other.plugin", title: "Draft" },
    ]);
  });

  it("sends the same list again after a failed send", async () => {
    track("p1");
    store.set({ p1: { title: "Draft" } });
    renderHook(() => usePluginUnsavedPanelsReporter());
    report.mockRejectedValueOnce(new Error("gone"));
    setViewUnsavedChanges("p1", {}, true);
    await Promise.resolve();
    await Promise.resolve();

    store.set({ p1: { title: "Draft" } });
    expect(report).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenLastCalledWith([
      { panelId: "p1", pluginId: "acme.demo", title: "Draft" },
    ]);
  });

  it("stops listening on unmount", () => {
    track("p1");
    store.set({ p1: { title: "Draft" } });
    const { unmount } = renderHook(() => usePluginUnsavedPanelsReporter());
    unmount();

    setViewUnsavedChanges("p1", {}, true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(store.listeners.size).toBe(0);
  });
});
