import { describe, it, expect, beforeEach } from "vitest";
import type { PluginPanelBadge } from "@shared/types/plugin";
import {
  usePluginPanelBadgeStore,
  _resetPluginPanelBadgeStoreForTest,
} from "./pluginPanelBadgeStore";

const DOT: PluginPanelBadge = { kind: "dot", color: "success" };
const LABEL: PluginPanelBadge = { kind: "label", text: "PR", color: "warning" };

function seed(badgesByPanelId: Record<string, Record<string, PluginPanelBadge>>): void {
  usePluginPanelBadgeStore.setState({ badgesByPanelId });
}

describe("pluginPanelBadgeStore.removePanel", () => {
  beforeEach(() => {
    _resetPluginPanelBadgeStoreForTest();
  });

  it("drops all badges for the removed panel and leaves other panels untouched", () => {
    seed({
      "panel-a": { "plugin-1": DOT, "plugin-2": LABEL },
      "panel-b": { "plugin-1": DOT },
    });

    const untouchedBefore = usePluginPanelBadgeStore.getState().badgesByPanelId["panel-b"];

    usePluginPanelBadgeStore.getState().removePanel("panel-a");

    const after = usePluginPanelBadgeStore.getState().badgesByPanelId;
    expect(after["panel-a"]).toBeUndefined();
    expect(after["panel-b"]).toEqual({ "plugin-1": DOT });
    // Unaffected panel keeps its object identity so its subscribers don't re-render.
    expect(after["panel-b"]).toBe(untouchedBefore);
  });

  it("is a reference-preserving no-op when the panel has no badges", () => {
    seed({ "panel-a": { "plugin-1": DOT } });
    const before = usePluginPanelBadgeStore.getState().badgesByPanelId;

    usePluginPanelBadgeStore.getState().removePanel("panel-missing");

    // Same root reference — no spurious store notification.
    expect(usePluginPanelBadgeStore.getState().badgesByPanelId).toBe(before);
  });

  it("removes a new map reference when a panel is pruned", () => {
    seed({ "panel-a": { "plugin-1": DOT }, "panel-b": { "plugin-1": DOT } });
    const before = usePluginPanelBadgeStore.getState().badgesByPanelId;

    usePluginPanelBadgeStore.getState().removePanel("panel-a");

    expect(usePluginPanelBadgeStore.getState().badgesByPanelId).not.toBe(before);
    expect(Object.keys(usePluginPanelBadgeStore.getState().badgesByPanelId)).toEqual(["panel-b"]);
  });
});
