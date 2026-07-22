// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PanelKindIcon } from "../PanelKindIcon";
import { PLUGIN_ICON_COMPONENTS, PLUGIN_ICON_IDS } from "@/components/icons/pluginIconRegistry";
import type { PluginIconId } from "@/components/icons/pluginIconRegistry";

function markup(iconId: string, props: { color?: string; size?: number } = {}): string {
  return render(<PanelKindIcon iconId={iconId} {...props} />).container.innerHTML;
}

/**
 * The glyph's own geometry, excluding the wrapper's sizing/color attributes —
 * so a renderer keeping a private map of permuted glyphs can't pass by merely
 * being "distinct".
 */
function glyph(iconId: string): string {
  return render(<PanelKindIcon iconId={iconId} />).container.querySelector("svg")!.innerHTML;
}

/** The same glyph rendered straight from the registry, as the oracle. */
function registryGlyph(id: PluginIconId): string {
  const Icon = PLUGIN_ICON_COMPONENTS[id];
  return render(<Icon />).container.querySelector("svg")!.innerHTML;
}

describe("PanelKindIcon", () => {
  it.each(PLUGIN_ICON_IDS)("draws %s from the shared registry", (id) => {
    expect(glyph(id)).toBe(registryGlyph(id));
  });

  it("renders ids the palette previously fell back on", () => {
    // `git-pull-request` and `file-diff` lived only in the header renderer, so
    // the palette showed a terminal glyph for them (#11298).
    const fallback = glyph("no-such-icon");
    expect(glyph("git-pull-request")).not.toBe(fallback);
    expect(glyph("file-diff")).not.toBe(fallback);
  });

  it("falls back to the terminal glyph, not the plugin glyph, for unknown ids", () => {
    // Panel chrome also renders built-ins and resume entries, so terminal is
    // the honest default here even though plugin surfaces use `package`.
    expect(glyph("no-such-icon")).toBe(registryGlyph("terminal"));
    expect(glyph("no-such-icon")).not.toBe(registryGlyph("package"));
  });

  it("treats inherited object keys as unknown ids", () => {
    // `iconId` is untrusted manifest input; a bare index lookup would resolve
    // these to functions off Object.prototype.
    const fallback = glyph("no-such-icon");
    for (const id of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(glyph(id), `"${id}" leaked an inherited value`).toBe(fallback);
    }
  });

  it("lets a registered agent id win over the generic registry", () => {
    // `claude` is not a registry id; it must resolve through `getAgentConfig`
    // to the brand mark rather than falling through to the terminal glyph.
    const agent = glyph("claude");
    expect(agent).not.toBe(registryGlyph("terminal"));
    expect(agent).not.toBe(glyph("no-such-icon"));
  });

  it("applies the caller's color and size to a registry glyph", () => {
    const html = markup("puzzle", { color: "rgb(1, 2, 3)", size: 24 });
    expect(html).toContain("rgb(1, 2, 3)");
    expect(html).toContain('width="24"');
    expect(html).toContain('height="24"');
  });
});
