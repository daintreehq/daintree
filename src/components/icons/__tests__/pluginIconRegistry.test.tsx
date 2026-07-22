// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  DEFAULT_PANEL_ICON,
  DEFAULT_PLUGIN_ICON,
  PLUGIN_ICON_COMPONENTS,
  PLUGIN_ICON_IDS,
  getPluginIconComponent,
  resolvePluginIcon,
  type PluginIconComponent,
} from "../pluginIconRegistry";

function markup(Icon: PluginIconComponent): string {
  return render(<Icon />).container.innerHTML;
}

describe("pluginIconRegistry", () => {
  it("maps exactly the advertised ids — no unrenderable id, no unreachable glyph", () => {
    expect(Object.keys(PLUGIN_ICON_COMPONENTS).sort()).toEqual([...PLUGIN_ICON_IDS].sort());
  });

  it("renders a real glyph for every advertised id", () => {
    for (const id of PLUGIN_ICON_IDS) {
      const Icon = getPluginIconComponent(id);
      expect(Icon, `no component registered for "${id}"`).toBeDefined();
      expect(markup(Icon!), `"${id}" rendered no svg`).toContain("<svg");
    }
  });

  it("gives distinct glyphs to ids the old split renderers conflated", () => {
    // `TerminalIcon` used to alias `monitor` onto the `monitor-play` glyph.
    expect(markup(PLUGIN_ICON_COMPONENTS.monitor)).not.toBe(
      markup(PLUGIN_ICON_COMPONENTS["monitor-play"])
    );
  });

  it("falls back to the plugin glyph for unknown ids", () => {
    expect(resolvePluginIcon("no-such-icon")).toBe(DEFAULT_PLUGIN_ICON);
    expect(resolvePluginIcon(undefined)).toBe(DEFAULT_PLUGIN_ICON);
    expect(resolvePluginIcon(null)).toBe(DEFAULT_PLUGIN_ICON);
    expect(resolvePluginIcon("")).toBe(DEFAULT_PLUGIN_ICON);
  });

  it("honours an explicit fallback without overriding a known id", () => {
    expect(resolvePluginIcon("no-such-icon", DEFAULT_PANEL_ICON)).toBe(DEFAULT_PANEL_ICON);
    expect(resolvePluginIcon("puzzle", DEFAULT_PANEL_ICON)).toBe(PLUGIN_ICON_COMPONENTS.puzzle);
  });

  it("exposes both fallbacks as registered ids so authors can name them explicitly", () => {
    expect(DEFAULT_PLUGIN_ICON).toBe(PLUGIN_ICON_COMPONENTS.package);
    expect(DEFAULT_PANEL_ICON).toBe(PLUGIN_ICON_COMPONENTS.terminal);
  });

  it("reports no component for an unknown id rather than silently substituting one", () => {
    expect(getPluginIconComponent("no-such-icon")).toBeUndefined();
    // Guards against a prototype-chain hit leaking a function through the map.
    expect(getPluginIconComponent("toString")).toBeUndefined();
    expect(getPluginIconComponent("constructor")).toBeUndefined();
  });
});
