import { describe, it, expect } from "vitest";
import type { LoadedPluginInfo, ProjectPluginInfo, SettingDefinition } from "@shared/types/plugin";
import { buildPluginSettingsSearchEntries, selectSearchablePlugins } from "../pluginSettingsSearch";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";
import { filterSettings } from "../settingsSearchUtils";

function plugin(
  instanceId: string,
  settings: SettingDefinition[],
  origin: "global" | "project" = "global"
): LoadedPluginInfo {
  return {
    instanceId,
    origin,
    manifest: { name: instanceId, displayName: `${instanceId} display`, contributes: { settings } },
  } as unknown as LoadedPluginInfo;
}

function projectRow(overrides: Partial<ProjectPluginInfo>): ProjectPluginInfo {
  return {
    projectId: "p1",
    id: "mine",
    instanceId: "project__p1__mine",
    displayName: "Mine",
    state: "active",
    muted: false,
    ...overrides,
  } as ProjectPluginInfo;
}

describe("buildPluginSettingsSearchEntries", () => {
  it("files user settings under the manager and project-scoped ones under Project settings", () => {
    const entries = buildPluginSettingsSearchEntries([
      {
        name: "Linear",
        plugin: plugin("acme.linear", [
          { id: "apiBase", type: "string", label: "API base", description: "Endpoint" },
          { id: "team", type: "string", scope: "project" },
        ] as SettingDefinition[]),
      },
    ]);
    expect(entries.map((e) => [e.id, e.tab, e.scope, e.title, e.section])).toEqual([
      ["plugin:acme.linear:apiBase", "plugins", "global", "API base", "Linear"],
      ["plugin:acme.linear:team", "project:plugins", "project", "team", "Linear"],
    ]);
    expect(entries[0]!.plugin).toEqual({ instanceId: "acme.linear", settingId: "apiBase" });
  });

  it("never indexes defaults or options", () => {
    const entries = buildPluginSettingsSearchEntries([
      {
        name: "Vault",
        plugin: plugin("acme.vault", [
          { id: "token", type: "secret", label: "Token", default: "hunter2-default" },
          { id: "mode", type: "select", label: "Mode", options: [{ value: "zebra-option" }] },
        ] as unknown as SettingDefinition[]),
      },
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/hunter2|zebra/);
  });

  it("is found by setting label and by plugin name", () => {
    const index = [
      ...SETTINGS_SEARCH_INDEX,
      ...buildPluginSettingsSearchEntries([
        {
          name: "Quokka Sync",
          plugin: plugin("acme.sync", [
            { id: "interval", type: "number", label: "Wombat interval" },
          ] as SettingDefinition[]),
        },
      ]),
    ];
    expect(filterSettings(index, "wombat")[0]?.id).toBe("plugin:acme.sync:interval");
    expect(filterSettings(index, "quokka").map((e) => e.id)).toContain("plugin:acme.sync:interval");
  });

  it("drops project-home entries when no project is open", () => {
    const index = buildPluginSettingsSearchEntries([
      {
        name: "P",
        plugin: plugin("acme.p", [
          { id: "a", type: "string", label: "Zork a" },
          { id: "b", type: "string", label: "Zork b", scope: "project" },
        ] as SettingDefinition[]),
      },
    ]);
    const ids = filterSettings(index, "zork", { hasProject: false }).map((e) => e.id);
    expect(ids).toEqual(["plugin:acme.p:a"]);
  });
});

describe("selectSearchablePlugins", () => {
  const installed = plugin("acme.installed", []);
  const own = plugin("project__p1__mine", [], "project");
  const other = plugin("project__p2__theirs", [], "project");

  it("keeps installed plugins and this project's running plugins", () => {
    const result = selectSearchablePlugins([installed, own, other], [projectRow({})], true);
    expect(result.map((r) => [r.plugin.instanceId, r.name])).toEqual([
      ["acme.installed", "acme.installed display"],
      ["project__p1__mine", "Mine"],
    ]);
  });

  it.each([
    ["untrusted folder", projectRow({}), false],
    ["muted", projectRow({ muted: true }), true],
    ["not active", projectRow({ state: "blocked" }), true],
  ])("leaves out a project plugin that is %s", (_name, row, trusted) => {
    const result = selectSearchablePlugins([own], [row], trusted);
    expect(result).toEqual([]);
  });
});
