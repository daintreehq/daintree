// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PanelKindIcon } from "../PanelKindIcon";
import { PLUGIN_ICON_IDS } from "@/components/icons/pluginIconRegistry";

function markup(iconId: string, props: { color?: string; size?: number } = {}): string {
  return render(<PanelKindIcon iconId={iconId} {...props} />).container.innerHTML;
}

describe("PanelKindIcon", () => {
  it("renders a distinct glyph for every advertised icon id", () => {
    const seen = new Map<string, string>();
    for (const id of PLUGIN_ICON_IDS) {
      const html = markup(id);
      expect(html, `"${id}" rendered no svg`).toContain("<svg");
      const clash = seen.get(html);
      expect(clash, `"${id}" renders identically to "${clash}"`).toBeUndefined();
      seen.set(html, id);
    }
  });

  it("renders ids the palette previously fell back on", () => {
    // `git-pull-request` and `file-diff` lived only in the header renderer, so
    // the palette showed a terminal glyph for them (#11298).
    const fallback = markup("no-such-icon");
    expect(markup("git-pull-request")).not.toBe(fallback);
    expect(markup("file-diff")).not.toBe(fallback);
  });

  it("falls back to the terminal glyph, not the plugin glyph, for unknown ids", () => {
    // Panel chrome also renders built-ins and resume entries, so terminal is
    // the honest default here even though plugin surfaces use `package`.
    expect(markup("no-such-icon")).toBe(markup("terminal"));
    expect(markup("no-such-icon")).not.toBe(markup("package"));
  });

  it("treats inherited object keys as unknown ids", () => {
    // `iconId` is untrusted manifest input; a bare index lookup would resolve
    // these to functions off Object.prototype.
    const fallback = markup("no-such-icon");
    for (const id of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(markup(id), `"${id}" leaked an inherited value`).toBe(fallback);
    }
  });

  it("lets a registered agent id win over the generic registry", () => {
    // `claude` is not a registry id; it must resolve through `getAgentConfig`
    // to the brand mark rather than falling through to the terminal glyph.
    const agent = markup("claude");
    expect(agent).not.toBe(markup("terminal"));
    expect(agent).toContain("<svg");
  });

  it("applies the caller's color and size to a registry glyph", () => {
    const html = markup("puzzle", { color: "rgb(1, 2, 3)", size: 24 });
    expect(html).toContain("rgb(1, 2, 3)");
    expect(html).toContain('width="24"');
    expect(html).toContain('height="24"');
  });
});
