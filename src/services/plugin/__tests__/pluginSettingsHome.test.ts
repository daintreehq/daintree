import { describe, expect, it } from "vitest";
import type { LoadedPluginInfo, PluginSetupStepContribution } from "@shared/types/plugin";
import { pluginHasSettings, resolvePluginSettingsTarget, setupHomeOf } from "../pluginSettingsHome";

const SETUP: PluginSetupStepContribution[] = [
  { id: "sync", title: "Run the first sync", done: { kind: "context", when: "acme.t.synced" } },
];

function plugin(
  origin: "global" | "project",
  extra: Partial<LoadedPluginInfo["manifest"]["contributes"]>
): LoadedPluginInfo {
  return {
    manifest: {
      name: "acme.t",
      version: "1.0.0",
      contributes: {
        panels: [],
        toolbarButtons: [],
        menuItems: [],
        keybindings: [],
        contextMenus: [],
        commands: [],
        views: [],
        mcpServers: [],
        skills: [],
        forgeProviders: [],
        fileDecorationProviders: [],
        fileEditors: [],
        agents: [],
        processTools: [],
        recipes: [],
        ...extra,
      },
    },
    instanceId: origin === "project" ? "project__proj-1__acme.t" : "acme.t",
    origin,
    projectId: origin === "project" ? "proj-1" : null,
    dir: "/tmp/acme.t",
    loadedAt: 0,
    isBuiltin: false,
    source: "sideload",
    installedAt: 0,
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    disabled: false,
    updateAvailable: null,
    devMode: false,
    pluginDanger: "safe",
  };
}

describe("plugin settings home for a setup checklist (#13824)", () => {
  it("gives a plugin with only setup steps a settings home", () => {
    const installed = plugin("global", { setup: SETUP });
    expect(pluginHasSettings(installed)).toBe(true);
    expect(pluginHasSettings(plugin("global", { setup: [] }))).toBe(false);
    expect(resolvePluginSettingsTarget("acme.t", undefined, [installed], null)).toEqual({
      ok: true,
      target: { plugin: installed, home: "manager" },
    });
  });

  it("puts the checklist with the account: the manager for installed, the project for project plugins", () => {
    expect(setupHomeOf(plugin("global", { setup: SETUP }))).toBe("manager");
    expect(setupHomeOf(plugin("project", { setup: SETUP }))).toBe("project");
    expect(setupHomeOf(plugin("global", {}))).toBeNull();
  });
});
