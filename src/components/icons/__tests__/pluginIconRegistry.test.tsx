// @vitest-environment jsdom
import fs from "fs";
import path from "path";
import { z } from "zod";
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

  it("gives every advertised id its own glyph", () => {
    // Two ids sharing a glyph would make them indistinguishable to a plugin
    // author picking between them — including `monitor`/`monitor-play`, which
    // `TerminalIcon` used to alias onto a single component.
    const seen = new Map<string, string>();
    for (const id of PLUGIN_ICON_IDS) {
      const Icon = PLUGIN_ICON_COMPONENTS[id];
      const geometry = render(<Icon />).container.querySelector("svg")!.innerHTML;
      const clash = seen.get(geometry);
      expect(clash, `"${id}" draws the same glyph as "${clash}"`).toBeUndefined();
      seen.set(geometry, id);
    }
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

  it("resolves every icon id the shipped sample manifest declares", () => {
    // Read the shipped sample manifest rather than hardcoding its icon ids, so
    // changing the sample can't leave this test green against a stale value.
    // Before #11304 every contribution rendered the same generic glyph
    // regardless of what its manifest asked for.
    const manifest = z
      .object({
        contributes: z.object({ toolbarButtons: z.array(z.object({ iconId: z.string() })) }),
      })
      .parse(
        JSON.parse(
          fs.readFileSync(
            path.resolve(__dirname, "../../../../plugins/sample/hello-daintree/plugin.json"),
            "utf-8"
          )
        )
      );
    const declared = manifest.contributes.toolbarButtons.map((b) => b.iconId);
    expect(declared.length).toBeGreaterThan(0);
    for (const iconId of declared) {
      expect(getPluginIconComponent(iconId), `sample iconId "${iconId}" fell back`).toBeDefined();
    }
  });
});
