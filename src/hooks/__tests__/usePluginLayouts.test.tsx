// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PluginLayoutConfig } from "@shared/types/plugin";

const { actions, applyPluginLayout } = vi.hoisted(() => ({
  actions: new Map<
    string,
    { title: string; mcpVisibility?: string; run: (args: unknown, ctx: unknown) => Promise<void> }
  >(),
  applyPluginLayout: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    has: (id: string) => actions.has(id),
    register: (definition: {
      id: string;
      title: string;
      run: (args: unknown, ctx: unknown) => Promise<void>;
    }) => {
      if (actions.has(definition.id)) throw new Error("duplicate");
      actions.set(definition.id, definition);
    },
    unregister: (id: string) => actions.delete(id),
  },
}));
vi.mock("@/services/layout/applyPluginLayout", () => ({ applyPluginLayout }));

import { pluginLayoutActionId, usePluginLayouts } from "../usePluginLayouts";
import { usePluginLayoutsStore } from "@/store/pluginLayoutsStore";

const layout = (localId: string, name = `${localId} layout`): PluginLayoutConfig => ({
  id: `acme.${localId}`,
  pluginId: "acme",
  pluginName: "Acme",
  name,
  entries: [{ target: { type: "panel", panelKindId: "acme.records" }, location: "grid" }],
});

const layoutsMock = vi.fn();
let push: ((payload: { layouts: PluginLayoutConfig[] }) => void) | null;

beforeEach(() => {
  actions.clear();
  applyPluginLayout.mockReset();
  push = null;
  usePluginLayoutsStore.setState({ layouts: [] });
  layoutsMock.mockReset().mockResolvedValue([]);
  Reflect.set(window, "electron", {
    plugin: {
      layouts: layoutsMock,
      onLayoutsChanged: (cb: typeof push) => {
        push = cb;
        return () => {};
      },
    },
  });
});

afterEach(() => cleanup());

describe("usePluginLayouts (#13780)", () => {
  it("lists each pulled layout in the palette, hidden from MCP, and applies it as the caller", async () => {
    layoutsMock.mockResolvedValue([layout("workspace", "Records workspace")]);
    renderHook(() => usePluginLayouts());

    await waitFor(() => expect(actions.size).toBe(1));
    const row = actions.get(pluginLayoutActionId("acme.workspace"));
    expect(row?.title).toBe("Apply layout: Records workspace");
    expect(row?.mcpVisibility).toBe("hidden");
    expect(usePluginLayoutsStore.getState().layouts.map((l) => l.id)).toEqual(["acme.workspace"]);

    const ctx = { dispatchSource: "user" };
    await row?.run(undefined, ctx);
    expect(applyPluginLayout).toHaveBeenCalledWith("acme.workspace", ctx);
  });

  it("lets a push win over a pull that lands after it", async () => {
    let resolvePull: (layouts: PluginLayoutConfig[]) => void = () => {};
    layoutsMock.mockReturnValue(new Promise((resolve) => (resolvePull = resolve)));
    renderHook(() => usePluginLayouts());

    act(() => push?.({ layouts: [layout("fresh")] }));
    await act(async () => resolvePull([layout("stale")]));

    expect([...actions.keys()]).toEqual([pluginLayoutActionId("acme.fresh")]);
    expect(usePluginLayoutsStore.getState().layouts.map((l) => l.id)).toEqual(["acme.fresh"]);
  });

  it("withdraws a layout that leaves the snapshot and re-registers a changed one", async () => {
    renderHook(() => usePluginLayouts());
    act(() => push?.({ layouts: [layout("a"), layout("b")] }));
    expect(actions.size).toBe(2);

    act(() => push?.({ layouts: [layout("a", "Renamed")] }));
    expect([...actions.keys()]).toEqual([pluginLayoutActionId("acme.a")]);
    expect(actions.get(pluginLayoutActionId("acme.a"))?.title).toBe("Apply layout: Renamed");
  });

  it("withdraws every row on unmount", () => {
    const { unmount } = renderHook(() => usePluginLayouts());
    act(() => push?.({ layouts: [layout("a")] }));
    unmount();
    expect(actions.size).toBe(0);
    expect(usePluginLayoutsStore.getState().layouts).toEqual([]);
  });
});
