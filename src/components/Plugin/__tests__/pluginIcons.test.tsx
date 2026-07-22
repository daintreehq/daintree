// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { pluginToolbarIconFor } from "../pluginIcons";

function renderGlyph(iconId: string | undefined): string {
  const Icon = pluginToolbarIconFor(iconId);
  const { container } = render(<Icon />);
  return container.innerHTML;
}

describe("pluginToolbarIconFor", () => {
  it("resolves an id the shipped sample manifest declares", () => {
    // `plugins/sample/hello-daintree/plugin.json` contributes `iconId:
    // "sparkles"`; before #11304 every contribution rendered the same generic
    // glyph regardless of what the manifest asked for.
    expect(renderGlyph("sparkles")).not.toBe(renderGlyph("definitely-not-an-icon"));
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
