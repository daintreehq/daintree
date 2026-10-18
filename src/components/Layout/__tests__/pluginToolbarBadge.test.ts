import { describe, it, expect } from "vitest";
import type { PluginPanelBadge } from "@shared/types/plugin";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import type { PluginToolbarButtonId } from "@shared/types/toolbar";
import {
  describeToolbarBadge,
  maxOverflowSeverity,
  mostSevereBadgeColor,
  overflowedPluginBadges,
  pluginBadgeOverflowSeverity,
  toolbarBadgeCountGlyph,
} from "../pluginToolbarBadge";

const label = (text: string, extra: Partial<PluginPanelBadge> = {}): PluginPanelBadge =>
  ({ kind: "label", text, ...extra }) as PluginPanelBadge;

function config(pluginId: string, local: string): ToolbarButtonConfig {
  return {
    id: `${pluginId}.${local}` as PluginToolbarButtonId,
    label: local,
    iconId: "puzzle",
    actionId: `${pluginId}.open`,
    priority: 3,
    pluginId,
  };
}

describe("toolbarBadgeCountGlyph", () => {
  it.each([
    ["0", "0"],
    ["9", "9"],
    ["10", "9+"],
    ["999999", "9+"],
    ["007", "7"],
    [" 3 ", "3"],
  ])("draws whole-number label %j as %j", (text, glyph) => {
    expect(toolbarBadgeCountGlyph(label(text))).toBe(glyph);
  });

  it.each(["9+", "-1", "1.5", "CI", "1e3"])("draws non-count label %j as a pip", (text) => {
    expect(toolbarBadgeCountGlyph(label(text))).toBeNull();
  });

  it("draws a dot as a pip", () => {
    expect(toolbarBadgeCountGlyph({ kind: "dot" })).toBeNull();
  });
});

describe("describeToolbarBadge", () => {
  it("keeps a label's full text beside its tooltip", () => {
    expect(describeToolbarBadge(label("12", { tooltip: "12 runs need you" }))).toBe(
      "12 — 12 runs need you"
    );
    expect(describeToolbarBadge(label("Failing"))).toBe("Failing");
  });

  it("names a dot by its tooltip, else by the colour it asked for", () => {
    expect(describeToolbarBadge({ kind: "dot", tooltip: "Syncing", color: "error" })).toBe(
      "Syncing"
    );
    expect(describeToolbarBadge({ kind: "dot", color: "error" })).toBe("error");
    expect(describeToolbarBadge({ kind: "dot", color: "warning" })).toBe("warning");
    expect(describeToolbarBadge({ kind: "dot", color: "success" })).toBe("badge");
    expect(describeToolbarBadge({ kind: "dot" })).toBe("badge");
  });
});

describe("severity", () => {
  it("picks the most severe colour, treating an unset one as default", () => {
    expect(mostSevereBadgeColor([])).toBeNull();
    expect(mostSevereBadgeColor([{ kind: "dot" }, { kind: "dot", color: "success" }])).toBe(
      "success"
    );
    expect(
      mostSevereBadgeColor([
        { kind: "dot", color: "error" },
        { kind: "dot", color: "warning" },
      ])
    ).toBe("error");
  });

  it("maps badge colours onto the overflow trigger's tiers", () => {
    expect(pluginBadgeOverflowSeverity([])).toBeNull();
    expect(pluginBadgeOverflowSeverity([{ kind: "dot", color: "success" }])).toBe("info");
    expect(pluginBadgeOverflowSeverity([{ kind: "dot", color: "warning" }])).toBe("warning");
    expect(pluginBadgeOverflowSeverity([{ kind: "dot", color: "error" }])).toBe("critical");
  });

  it("keeps the higher of two tiers", () => {
    expect(maxOverflowSeverity(null, "info")).toBe("info");
    expect(maxOverflowSeverity("warning", null)).toBe("warning");
    expect(maxOverflowSeverity("info", "critical")).toBe("critical");
    expect(maxOverflowSeverity("warning", "info")).toBe("warning");
  });
});

describe("overflowedPluginBadges", () => {
  const promoted = config("acme.beads", "needs");
  const trayOnly = config("acme.beads", "queue");
  const configs = new Map([
    [promoted.id, promoted],
    [trayOnly.id, trayOnly],
  ]);
  const pinned = { [promoted.id]: true };
  const badges = { "acme.beads": { needs: label("4"), queue: label("2") } };

  it("counts an overflowed promoted button's own badge only", () => {
    expect(overflowedPluginBadges([promoted.id], configs, pinned, badges)).toEqual([label("4")]);
  });

  it("counts an overflowed tray's un-promoted rows only, so one badge never lights two menus", () => {
    expect(overflowedPluginBadges(["plugin-tray"], configs, pinned, badges)).toEqual([label("2")]);
  });

  it("counts nothing while neither route overflowed", () => {
    expect(overflowedPluginBadges(["problems"], configs, pinned, badges)).toEqual([]);
  });
});
