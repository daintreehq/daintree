import { describe, expect, it } from "vitest";
import type { LoadedPluginInfo, SettingDefinition } from "@shared/types/plugin";
import {
  matchPluginSettingFields,
  pluginSettingFilterIndex,
} from "../pluginSettingFieldSearch";
import { buildPluginSettingsSearchEntries } from "../pluginSettingsSearch";
import { filterSettings } from "../settingsSearchUtils";

const DEFS: SettingDefinition[] = [
  { id: "openPrCap", type: "number", label: "Open pull request limit" },
  {
    id: "hostForward",
    type: "string",
    label: "Forwarded hosts",
    description: "Proxy targets the sandbox may reach",
  },
  { id: "pollSeconds", type: "number", label: "Poll interval" },
  { id: "proxyUrl", type: "string" },
  { id: "theme", type: "string", label: "Board theme", description: "Colours of the driver board" },
];

const match = (query: string) => {
  const found = matchPluginSettingFields(pluginSettingFilterIndex(DEFS), query);
  return found === null ? null : [...found].sort();
};

describe("matchPluginSettingFields", () => {
  it("filters nothing for a blank query", () => {
    expect(match("")).toBeNull();
    expect(match("   ")).toBeNull();
  });

  it("matches a field by its label, its description or its key", () => {
    expect(match("pull request")).toEqual(["openPrCap"]);
    expect(match("sandbox")).toEqual(["hostForward"]);
    expect(match("openprcap")).toEqual(["openPrCap"]);
    // No label: the key is what the row shows, and what it is found by.
    expect(match("proxyurl")).toEqual(["proxyUrl"]);
  });

  it("needs every word to match, each in any of the three", () => {
    expect(match("hosts proxy")).toEqual(["hostForward"]);
    expect(match("hosts board")).toEqual([]);
  });

  it("prefers literal hits and still forgives a typo when there are none", () => {
    // "proxy" is literally in one field's key and another's description: the
    // fuzzy near-misses that contain it nowhere are dropped.
    expect(match("proxy")).toEqual(["hostForward", "proxyUrl"]);
    expect(match("intervl")).toEqual(["pollSeconds"]);
  });

  it("is narrower than the dialog: the plugin's name finds no field there", () => {
    const plugin = {
      instanceId: "acme.driver",
      origin: "global",
      manifest: { name: "acme.driver", contributes: { settings: DEFS } },
    } as unknown as LoadedPluginInfo;
    const dialogRows = buildPluginSettingsSearchEntries([{ plugin, name: "Driver" }]).filter(
      (e) => e.plugin?.settingId !== undefined
    );
    // In the dialog every field carries the plugin's name and its tab's label.
    expect(filterSettings(dialogRows, "driver")).toHaveLength(DEFS.length);
    expect(filterSettings(dialogRows, "plugin manager")).toHaveLength(DEFS.length);
    // In the plugin's own form only a field that says it matches.
    expect(match("driver")).toEqual(["theme"]);
    expect(match("plugin manager")).toEqual([]);
  });
});
