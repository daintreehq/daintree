// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";

const panelsById = vi.hoisted(() => ({}) as Record<string, { kind: string }>);
vi.mock("@/store/storeAccessors", () => ({
  getPanelStoreSnapshot: () => ({
    panelsById,
    panelIds: Object.keys(panelsById),
    tabGroups: new Map(),
  }),
}));

const kindOwners = vi.hoisted(() => new Map<string, string>());
vi.mock("@shared/config/panelKindRegistry", () => ({
  getPanelKindConfig: (kind: string) =>
    kindOwners.has(kind) ? { id: kind, extensionId: kindOwners.get(kind) } : undefined,
}));

const getPluginStyleReportForRoots = vi.hoisted(() =>
  vi.fn(async (roots: readonly Element[]) =>
    roots.length === 0 ? null : { generated: ["p-4"], notGenerated: ["bg-red-500"] }
  )
);
vi.mock("@/services/plugin/pluginStyleContract", () => ({ getPluginStyleReportForRoots }));

const { findPluginStyleRoots, usePluginStyleReport } = await import("../usePluginStyleReport");

function mountPanel(panelId: string, kind: string, ownerId: string): HTMLElement {
  panelsById[panelId] = { kind };
  kindOwners.set(kind, ownerId);
  const panel = document.createElement("div");
  panel.setAttribute("data-panel-id", panelId);
  const root = document.createElement("div");
  root.setAttribute(PLUGIN_STYLE_ROOT_ATTRIBUTE, "");
  root.innerHTML = `<span class="p-4 bg-red-500"></span>`;
  panel.appendChild(root);
  document.body.appendChild(panel);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = "";
  for (const key of Object.keys(panelsById)) delete panelsById[key];
  kindOwners.clear();
});

describe("findPluginStyleRoots", () => {
  it("attributes a root to the plugin whose kind owns the hosting panel", () => {
    const mine = mountPanel("p1", "acme.demo.main", "acme.demo");
    mountPanel("p2", "other.plugin.main", "other.plugin");
    expect(findPluginStyleRoots("acme.demo")).toEqual([mine]);
  });

  it("does not count a root outside any panel, such as a body portal", () => {
    const portal = document.createElement("div");
    portal.setAttribute(PLUGIN_STYLE_ROOT_ATTRIBUTE, "");
    document.body.appendChild(portal);
    expect(findPluginStyleRoots("acme.demo")).toEqual([]);
  });

  it("keeps project instances of the same manifest apart", () => {
    mountPanel("p1", "project:a/acme.demo/main", "project__a__acme.demo");
    expect(findPluginStyleRoots("acme.demo")).toEqual([]);
    expect(findPluginStyleRoots("project__a__acme.demo")).toHaveLength(1);
  });
});

describe("usePluginStyleReport", () => {
  it("reports no views when none of the plugin's panels is mounted", async () => {
    const { result } = renderHook(() => usePluginStyleReport("acme.demo"));
    await act(async () => {});
    expect(result.current.state.status).toBe("no-views");
  });

  it("reports the mounted view's classes and re-reads on recheck", async () => {
    const { result } = renderHook(() => usePluginStyleReport("acme.demo"));
    await act(async () => {});
    expect(result.current.state.status).toBe("no-views");

    const mine = mountPanel("p1", "acme.demo.main", "acme.demo");
    mountPanel("p2", "other.plugin.main", "other.plugin");
    await act(async () => result.current.recheck());
    expect(getPluginStyleReportForRoots).toHaveBeenLastCalledWith([mine]);
    const state = result.current.state;
    expect(state.status).toBe("ready");
    if (state.status === "ready") expect(state.report.notGenerated).toEqual(["bg-red-500"]);
  });

  it("surfaces a failed check as an error state", async () => {
    mountPanel("p1", "acme.demo.main", "acme.demo");
    getPluginStyleReportForRoots.mockRejectedValueOnce(new Error("compiler failed"));
    const { result } = renderHook(() => usePluginStyleReport("acme.demo"));
    await act(async () => {});
    expect(result.current.state.status).toBe("error");
  });
});
