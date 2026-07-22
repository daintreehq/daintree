// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import fs from "fs";
import path from "path";
import { pluginToolbarIconFor } from "../pluginIcons";

// Read the shipped sample manifest rather than hardcoding its icon id, so
// changing the sample can't leave this test green against a stale value.
const SAMPLE_MANIFEST = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../../../plugins/sample/hello-daintree/plugin.json"),
    "utf-8"
  )
) as { contributes: { toolbarButtons: { iconId: string }[] } };

function renderGlyph(iconId: string | undefined): string {
  const Icon = pluginToolbarIconFor(iconId);
  const { container } = render(<Icon />);
  return container.innerHTML;
}

describe("pluginToolbarIconFor", () => {
  it("resolves every icon id the shipped sample manifest declares", () => {
    // Before #11304 every contribution rendered the same generic glyph
    // regardless of what its manifest asked for.
    const fallback = renderGlyph("definitely-not-an-icon");
    const declared = SAMPLE_MANIFEST.contributes.toolbarButtons.map((b) => b.iconId);
    expect(declared.length).toBeGreaterThan(0);
    for (const iconId of declared) {
      expect(renderGlyph(iconId), `sample iconId "${iconId}" fell back`).not.toBe(fallback);
    }
  });

  it("falls back to the same glyph for unknown and missing ids", () => {
    const fallback = renderGlyph(undefined);
    expect(renderGlyph("definitely-not-an-icon")).toBe(fallback);
    expect(renderGlyph("")).toBe(fallback);
  });

  it("uses the plugin box glyph as the fallback, not an unrelated concept", () => {
    // The fallback has to read as "this came from a plugin" — it is the same
    // glyph the tray trigger and the Plugin Manager use.
    expect(renderGlyph("definitely-not-an-icon")).toBe(renderGlyph("package"));
  });

  it("returns distinct glyphs for distinct known ids", () => {
    expect(renderGlyph("terminal")).not.toBe(renderGlyph("globe"));
  });
});
