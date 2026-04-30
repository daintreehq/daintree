import { describe, expect, it } from "vitest";
import type { TerminalInstance } from "@/store";
import type { TabGroup } from "@/types";
import { buildDockRenderItems } from "../dockRenderItems";

function terminal(id: string): TerminalInstance {
  return {
    id,
    title: id,
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "dock",
    isVisible: false,
  };
}

function group(panelIds: string[], activeTabId = panelIds[0] ?? ""): TabGroup {
  return {
    id: "group-1",
    panelIds,
    activeTabId,
    location: "dock",
  };
}

describe("buildDockRenderItems", () => {
  it("drops stale groups whose panels no longer resolve to dock terminals", () => {
    const items = buildDockRenderItems([group(["closed-panel"])], () => []);

    expect(items).toEqual([]);
  });

  it("repairs panelIds and activeTabId to match resolved panels", () => {
    const items = buildDockRenderItems(
      [group(["closed-panel", "live-panel"], "closed-panel")],
      (groupId) => (groupId === "group-1" ? [terminal("live-panel")] : [])
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.group.panelIds).toEqual(["live-panel"]);
    expect(items[0]?.group.activeTabId).toBe("live-panel");
    expect(items[0]?.panels.map((panel) => panel.id)).toEqual(["live-panel"]);
  });

  it("excludes the help terminal from normal dock rendering", () => {
    const items = buildDockRenderItems(
      [group(["help", "live-panel"], "help")],
      () => [terminal("help"), terminal("live-panel")],
      "help"
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.group.panelIds).toEqual(["live-panel"]);
    expect(items[0]?.panels.map((panel) => panel.id)).toEqual(["live-panel"]);
  });

  it("renders ungrouped dock terminals even when group derivation is empty", () => {
    const items = buildDockRenderItems([], () => [], null, [terminal("ungrouped-dock")]);

    expect(items).toHaveLength(1);
    expect(items[0]?.group).toMatchObject({
      id: "ungrouped-dock",
      location: "dock",
      activeTabId: "ungrouped-dock",
      panelIds: ["ungrouped-dock"],
    });
    expect(items[0]?.panels.map((panel) => panel.id)).toEqual(["ungrouped-dock"]);
  });

  it("does not duplicate dock terminals already rendered through a group", () => {
    const items = buildDockRenderItems(
      [group(["live-panel"])],
      () => [terminal("live-panel")],
      null,
      [terminal("live-panel")]
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.group.panelIds).toEqual(["live-panel"]);
  });
});
