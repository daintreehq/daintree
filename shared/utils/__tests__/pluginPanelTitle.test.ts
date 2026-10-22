import { describe, expect, it } from "vitest";
import { normalizePluginPanelTitle } from "../pluginPanelTitle.js";
import { PANEL_VIEW_TITLE_MAX } from "../../types/plugin.js";

describe("normalizePluginPanelTitle", () => {
  it("keeps an ordinary title, trimmed", () => {
    expect(normalizePluginPanelTitle("  Record #42 ")).toBe("Record #42");
  });

  it("reads null and a blank title as going back to the kind's name", () => {
    expect(normalizePluginPanelTitle(null)).toBe("");
    expect(normalizePluginPanelTitle("   ")).toBe("");
  });

  it("refuses a value that is not a string", () => {
    expect(normalizePluginPanelTitle(undefined)).toBeNull();
    expect(normalizePluginPanelTitle(42)).toBeNull();
    expect(normalizePluginPanelTitle({ title: "x" })).toBeNull();
  });

  it("holds the title to one line, without control characters", () => {
    const escape = String.fromCharCode(0x1b);
    const nextLine = String.fromCharCode(0x85);
    expect(normalizePluginPanelTitle(`Record\n#42\t${escape}[31m${nextLine}open`)).toBe(
      "Record #42 [31m open"
    );
  });

  it("cuts a long title at the cap without leaving a trailing space", () => {
    const long = `${"a".repeat(PANEL_VIEW_TITLE_MAX - 1)} tail`;
    const title = normalizePluginPanelTitle(long);
    expect(title).toBe("a".repeat(PANEL_VIEW_TITLE_MAX - 1));
    expect(normalizePluginPanelTitle("b".repeat(PANEL_VIEW_TITLE_MAX + 20))).toHaveLength(
      PANEL_VIEW_TITLE_MAX
    );
  });
});
