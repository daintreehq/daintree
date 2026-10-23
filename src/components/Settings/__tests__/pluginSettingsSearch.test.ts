import { describe, it, expect } from "vitest";
import type { LoadedPluginInfo, ProjectPluginInfo, SettingDefinition } from "@shared/types/plugin";
import { buildPluginSettingsSearchEntries, selectSearchablePlugins } from "../pluginSettingsSearch";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";
import { filterSettings } from "../settingsSearchUtils";

function plugin(
  instanceId: string,
  settings: SettingDefinition[],
  origin: "global" | "project" = "global",
  extra: Record<string, unknown> = {}
): LoadedPluginInfo {
  return {
    instanceId,
    origin,
    manifest: {
      name: instanceId,
      displayName: `${instanceId} display`,
      contributes: { settings, ...extra },
    },
  } as unknown as LoadedPluginInfo;
}

const fieldRows = <T extends { plugin?: { settingId?: string } }>(entries: T[]): T[] =>
  entries.filter((e) => e.plugin?.settingId !== undefined);

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
    expect(fieldRows(entries).map((e) => [e.id, e.tab, e.scope, e.title, e.section])).toEqual([
      ["plugin:acme.linear:apiBase", "plugins", "global", "API base", "Linear"],
      ["plugin:acme.linear:team", "project:plugins", "project", "team", "Linear"],
    ]);
    expect(fieldRows(entries)[0]!.plugin).toEqual({
      instanceId: "acme.linear",
      settingId: "apiBase",
    });
    // Each home the plugin shows something in is a result of its own.
    expect(entries.filter((e) => e.id.includes("@home")).map((e) => [e.tab, e.plugin])).toEqual([
      ["plugins", { instanceId: "acme.linear", scope: "user" }],
      ["project:plugins", { instanceId: "acme.linear", scope: "project" }],
    ]);
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

  it("finds a plugin with only an account, in the manager for an installed plugin", () => {
    const entries = buildPluginSettingsSearchEntries([
      {
        name: "Linear",
        plugin: plugin("acme.linear", [], "global", {
          account: { kind: "token", label: "Linear account", description: "Paste an API key" },
        }),
      },
    ]);
    const account = filterSettings(entries, "linear account")[0];
    expect(account).toMatchObject({
      tab: "plugins",
      scope: "global",
      plugin: { instanceId: "acme.linear", section: "account" },
    });
    expect(filterSettings(entries, "connection").map((e) => e.id)).toContain(
      "plugin:acme.linear:@account"
    );
  });

  it("files a project plugin's account and setup under its project", () => {
    const entries = buildPluginSettingsSearchEntries([
      {
        name: "Mine",
        plugin: plugin("project__p1__mine", [], "project", {
          account: { kind: "token", label: "Service" },
          setup: [
            {
              id: "sync",
              title: "Run the first sync",
              done: { kind: "context", when: "mine.synced" },
            },
          ],
        }),
      },
    ]);
    expect(entries.map((e) => [e.id, e.tab, e.plugin])).toEqual([
      [
        "plugin:project__p1__mine:@home:project",
        "project:plugins",
        { instanceId: "project__p1__mine" },
      ],
      [
        "plugin:project__p1__mine:@setup:sync",
        "project:plugins",
        { instanceId: "project__p1__mine", section: "setup" },
      ],
      [
        "plugin:project__p1__mine:@account",
        "project:plugins",
        { instanceId: "project__p1__mine", section: "account" },
      ],
    ]);
    expect(filterSettings(entries, "first sync", { hasProject: false })).toEqual([]);
  });

  it("finds an installed plugin's custom section and its pages in both homes", () => {
    const entries = buildPluginSettingsSearchEntries([
      {
        name: "Board",
        plugin: plugin("acme.board", [], "global", {
          views: [
            {
              id: "prefs",
              componentPath: "dist/prefs.js",
              location: "settings",
              title: "Board layout",
              pages: [
                { id: "columns", title: "Column mapping", description: "Statuses to columns" },
              ],
            },
          ],
        }),
      },
    ]);
    const custom = filterSettings(entries, "board layout").filter((e) => e.id.includes("@custom"));
    expect(custom.map((e) => [e.tab, e.plugin])).toEqual([
      ["plugins", { instanceId: "acme.board", section: "custom", scope: "user" }],
      ["project:plugins", { instanceId: "acme.board", section: "custom", scope: "project" }],
    ]);
    expect(filterSettings(entries, "column mapping", { hasProject: false })[0]?.plugin).toEqual({
      instanceId: "acme.board",
      section: "custom",
      page: "columns",
      scope: "user",
    });
  });

  it("offers only the home in Project settings for a forge plugin that keeps its settings in Code forge", () => {
    const entries = buildPluginSettingsSearchEntries([
      {
        name: "GitLab",
        plugin: plugin(
          "acme.gitlab",
          [
            { id: "host", type: "string", label: "Host" },
            { id: "group", type: "string", label: "Group", scope: "project" },
          ] as SettingDefinition[],
          "global",
          {
            forgeProviders: [
              { id: "gitlab", name: "GitLab", slots: { settingsTab: "gitlab.tab" } },
            ],
            views: [{ id: "prefs", componentPath: "dist/prefs.js", location: "settings" }],
          }
        ),
      },
    ]);
    expect(entries.filter((e) => e.tab === "project:plugins").map((e) => e.id)).toEqual([
      "plugin:acme.gitlab:@home:project",
    ]);
    expect(entries.some((e) => e.id === "plugin:acme.gitlab:host")).toBe(true);
  });

  it("indexes no account endpoint, client id or setup check", () => {
    const entries = buildPluginSettingsSearchEntries([
      {
        name: "Vault",
        plugin: plugin("acme.vault", [], "global", {
          account: {
            kind: "oauth2",
            label: "Vault",
            authorizeUrl: "https://auth.example/zebra-authorize",
            tokenUrl: "https://auth.example/zebra-token",
            clientId: "zebra-client",
            scopes: ["zebra-scope"],
            identity: { url: "https://api.example/zebra-me", field: "zebra.login" },
          },
          setup: [
            {
              id: "key",
              title: "Add a key",
              done: { kind: "context", when: "zebra.when" },
              action: { kind: "command", actionId: "acme.vault.zebraCommand" },
            },
          ],
        }),
      },
    ]);
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toMatch(/zebra/);
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
