import { describe, expect, it } from "vitest";
import type { FilePanelData, PtyPanelData } from "@shared/types/panel";
import type { TabGroup } from "@/types";
import { buildDockRenderItems } from "../dockRenderItems";

function terminal(id: string): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "dock",
    isVisible: false,
  } as PtyPanelData;
}

function group(panelIds: string[], activeTabId = panelIds[0] ?? ""): TabGroup {
  return {
    id: "group-1",
    panelIds,
    activeTabId,
    location: "dock",
  };
}

function filePanel(id: string): FilePanelData {
  return {
    id,
    title: id,
    kind: "file",
    location: "dock",
    isVisible: false,
    filePath: `/repo/${id}.md`,
  } as FilePanelData;
}

describe("buildDockRenderItems", () => {
  it("renders a docked file panel as a standalone chip", () => {
    const items = buildDockRenderItems([], () => [], null, [filePanel("spec")]);

    expect(items).toHaveLength(1);
    expect(items[0]?.panels[0]?.kind).toBe("file");
    expect(items[0]?.group.panelIds).toEqual(["spec"]);
  });

  it("renders a file panel standalone even when its stored group only resolves PTY panels", () => {
    // A grid tab group containing a terminal and a file panel moved to the
    // dock: groups resolve PTY-only, so the file panel falls through to the
    // flat membership list and must not vanish.
    const items = buildDockRenderItems(
      [group(["term-1", "spec"], "term-1")],
      () => [terminal("term-1")],
      null,
      [terminal("term-1"), filePanel("spec")]
    );

    expect(items).toHaveLength(2);
    expect(items[0]?.group.panelIds).toEqual(["term-1"]);
    expect(items[1]?.panels[0]?.id).toBe("spec");
  });

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
