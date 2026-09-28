// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import { getSettingsTabEntry } from "@/components/Settings/settingsTabRegistry";
import {
  SETTINGS_CONTEXT_MENU_TABS,
  SETTINGS_CONTEXT_MENU_TROUBLESHOOTING,
} from "../ToolbarSettingsButton";
import { TOOLBAR_CUSTOMIZE_ICON } from "../toolbarMenuStrings";

// The settings button's right-click menu is a shortcut into Settings, so each
// row has to read as the tab it opens: the same name and the same glyph the
// Settings sidebar shows for that tab.
describe("ToolbarSettingsButton context menu rows", () => {
  const rows = [...SETTINGS_CONTEXT_MENU_TABS, SETTINGS_CONTEXT_MENU_TROUBLESHOOTING];

  it.each(rows.map((row) => [row.tab, row] as const))(
    "%s wears its settings tab's name and icon",
    (_tab, row) => {
      const entry = getSettingsTabEntry(row.tab);
      expect(entry, `no settings tab "${row.tab}"`).toBeDefined();
      expect(row.label).toBe(entry?.label);
      const icon = entry?.icon;
      expect(isValidElement(icon) ? icon.type : undefined).toBe(row.icon);
    }
  );
});

// "Customize toolbar…" opens the Toolbar tab from every toolbar menu and the
// launcher, so it carries that tab's glyph rather than a generic gear.
describe("Customize toolbar icon", () => {
  it("is the Toolbar settings tab's icon", () => {
    const entry = getSettingsTabEntry("toolbar");
    const icon = entry?.icon;
    expect(isValidElement(icon) ? icon.type : undefined).toBe(TOOLBAR_CUSTOMIZE_ICON);
  });
});
