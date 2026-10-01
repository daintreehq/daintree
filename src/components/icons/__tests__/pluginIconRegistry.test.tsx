// @vitest-environment jsdom
import fs from "fs";
import path from "path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import {
  DEFAULT_PANEL_ICON,
  DEFAULT_PLUGIN_ICON,
  PLUGIN_ICON_COMPONENTS,
  PLUGIN_ICON_IDS,
  getPluginIconComponent,
  resolvePluginIcon,
  type PluginIconComponent,
} from "../pluginIconRegistry";
import { setPluginCustomIcons } from "../pluginCustomIconStore";

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

  describe("plugin custom icons (#13143)", () => {
    const KEY = "plugin-icon:acme.tools:./icons/acme.svg";
    const SVG =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="red" d="M4 4h16v16H4z"/></svg>';
    const asset = { key: KEY, pluginId: "acme.tools", pluginName: "Acme", svg: SVG };

    afterEach(() => {
      setPluginCustomIcons([]);
    });

    it("hands back one stable component per key and fallback", () => {
      expect(resolvePluginIcon(KEY)).toBe(resolvePluginIcon(KEY));
      expect(resolvePluginIcon(KEY, DEFAULT_PANEL_ICON)).not.toBe(resolvePluginIcon(KEY));
      // A custom key isn't a generic id, so the generic lookup stays honest.
      expect(getPluginIconComponent(KEY)).toBeUndefined();
    });

    it("draws the fallback until the asset arrives, then the mask, then the fallback again", () => {
      const Icon = resolvePluginIcon(KEY, DEFAULT_PANEL_ICON);
      const { container } = render(<Icon className="h-4 w-4" />);
      expect(container.querySelector("svg")).not.toBeNull();
      expect(container.querySelector("[data-plugin-icon]")).toBeNull();

      act(() => setPluginCustomIcons([asset]));
      const span = container.querySelector<HTMLElement>(`[data-plugin-icon="${KEY}"]`);
      expect(span).not.toBeNull();
      expect(container.querySelector("svg")).toBeNull();

      act(() => setPluginCustomIcons([]));
      expect(container.querySelector("[data-plugin-icon]")).toBeNull();
      expect(container.querySelector("svg")).not.toBeNull();
    });

    it("paints the svg as a currentColor mask rather than inserting its markup", () => {
      setPluginCustomIcons([asset]);
      const Icon = resolvePluginIcon(KEY);
      const { container } = render(<Icon />);
      const span = container.querySelector<HTMLElement>("[data-plugin-icon]")!;
      expect(span.innerHTML).toBe("");
      expect(span.getAttribute("aria-hidden")).toBe("true");
      expect(span.style.backgroundColor).toBe("currentcolor");
      const mask = span.style.getPropertyValue("mask-image") || span.style.maskImage;
      expect(mask).toContain("data:image/svg+xml,");
      expect(decodeURIComponent(mask)).toContain('fill="red"');
    });

    it("sizes like a Lucide glyph: 24px by default, class or explicit size when given", () => {
      setPluginCustomIcons([asset]);
      const Icon = resolvePluginIcon(KEY);
      const byDefault = render(<Icon />).container.querySelector<HTMLElement>("[data-plugin-icon]")!;
      expect(byDefault.className).toContain("size-6");

      const byClass = render(<Icon className="h-3.5 w-3.5" />).container.querySelector<HTMLElement>(
        "[data-plugin-icon]"
      )!;
      expect(byClass.className).not.toContain("size-6");
      expect(byClass.className).toContain("w-3.5");

      const bySize = render(<Icon size={16} />).container.querySelector<HTMLElement>(
        "[data-plugin-icon]"
      )!;
      expect(bySize.className).not.toContain("size-6");
      expect(bySize.style.width).toBe("16px");
      expect(bySize.style.height).toBe("16px");
    });

    it("lets a caller colour override flow into the mask through currentColor", () => {
      setPluginCustomIcons([asset]);
      const Icon = resolvePluginIcon(KEY);
      const span = render(<Icon style={{ color: "rgb(1, 2, 3)" }} />).container.querySelector<
        HTMLElement
      >("[data-plugin-icon]")!;
      expect(span.style.color).toBe("rgb(1, 2, 3)");
      expect(span.style.backgroundColor).toBe("currentcolor");
    });
  });
});
