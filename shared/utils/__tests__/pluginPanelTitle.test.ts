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

  it("drops bidi controls, which could reorder the tab strip around the title", () => {
    const override = String.fromCharCode(0x202e);
    const isolate = String.fromCharCode(0x2067);
    expect(normalizePluginPanelTitle(`Record${override}24#${isolate}x`)).toBe("Record 24# x");
  });

  it("reads a title of invisible spacers as blank, and drops a lone surrogate half", () => {
    const zeroWidth = String.fromCharCode(0x200b, 0xfeff, 0x2060);
    expect(normalizePluginPanelTitle(zeroWidth)).toBe("");
    expect(normalizePluginPanelTitle(`Record${String.fromCharCode(0xd83d)}#42`)).toBe("Record #42");
  });

  it("keeps the joiner inside an emoji sequence", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(normalizePluginPanelTitle(`Team ${family}`)).toBe(`Team ${family}`);
  });

  it("never cuts inside a surrogate pair", () => {
    const title = normalizePluginPanelTitle(`${"a".repeat(PANEL_VIEW_TITLE_MAX - 1)}\u{1F600}tail`);
    expect(title).toBe(`${"a".repeat(PANEL_VIEW_TITLE_MAX - 1)}\u{1F600}`);
    expect(Array.from(title ?? "")).toHaveLength(PANEL_VIEW_TITLE_MAX);
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
