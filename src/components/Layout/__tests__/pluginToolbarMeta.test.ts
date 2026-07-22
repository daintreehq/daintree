import { describe, expect, it } from "vitest";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import { buildPluginToolbarMeta } from "../pluginToolbarMeta";
import { DEFAULT_PLUGIN_ICON, PLUGIN_ICON_COMPONENTS } from "@/components/icons/pluginIconRegistry";

function config(overrides: Partial<ToolbarButtonConfig> = {}): ToolbarButtonConfig {
  return {
    id: "acme.plan" as ToolbarButtonConfig["id"],
    label: "Plan",
    iconId: "list",
    actionId: "acme.plan-from-issue",
    priority: 3,
    pluginId: "acme",
    ...overrides,
  };
}

function build(configs: ToolbarButtonConfig[]) {
  const byId = new Map(configs.map((c) => [c.id as string, c]));
  return buildPluginToolbarMeta(
    configs.map((c) => c.id as string),
    byId
  );
}

describe("buildPluginToolbarMeta", () => {
  it("renders the icon the manifest declared instead of a fixed glyph", () => {
    const meta = build([config({ iconId: "list" })]);

    expect(meta["acme.plan"]?.icon).toBe(PLUGIN_ICON_COMPONENTS.list);
  });

  it("varies the icon with iconId alone, holding the button id fixed", () => {
    // Same id, same label, same plugin — only `iconId` differs. A lookup keyed
    // on anything but `iconId` would return the same glyph for both.
    const asList = build([config({ iconId: "list" })]);
    const asGauge = build([config({ iconId: "gauge" })]);

    expect(asList["acme.plan"]?.icon).toBe(PLUGIN_ICON_COMPONENTS.list);
    expect(asGauge["acme.plan"]?.icon).toBe(PLUGIN_ICON_COMPONENTS.gauge);
    expect(asList["acme.plan"]?.icon).not.toBe(asGauge["acme.plan"]?.icon);
  });

  it("resolves each button independently", () => {
    const meta = build([
      config({ id: "acme.plan" as ToolbarButtonConfig["id"], iconId: "list" }),
      config({ id: "acme.chart" as ToolbarButtonConfig["id"], iconId: "gauge" }),
    ]);

    expect(meta["acme.plan"]?.icon).not.toBe(meta["acme.chart"]?.icon);
    expect(meta["acme.chart"]?.icon).toBe(PLUGIN_ICON_COMPONENTS.gauge);
  });

  it("falls back to the generic plugin glyph for an unrecognized icon id", () => {
    const meta = build([config({ iconId: "no-such-icon" })]);

    expect(meta["acme.plan"]?.icon).toBe(DEFAULT_PLUGIN_ICON);
  });

  it("does not resolve agent brand ids — the toolbar has no brand-icon path", () => {
    const meta = build([config({ iconId: "claude" })]);

    expect(meta["acme.plan"]?.icon).toBe(DEFAULT_PLUGIN_ICON);
  });

  it("carries the label and attributes the button to its plugin", () => {
    const meta = build([config({ label: "Plan", pluginId: "acme" })]);

    expect(meta["acme.plan"]?.label).toBe("Plan");
    expect(meta["acme.plan"]?.description).toContain("acme");
  });

  it("skips ids with no registered config rather than emitting a blank entry", () => {
    const meta = buildPluginToolbarMeta(["acme.ghost"], new Map());

    expect(Object.keys(meta)).toEqual([]);
  });
});
