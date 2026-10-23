import { describe, expect, it } from "vitest";
import type { LoadedPluginInfo, PluginSetupStepContribution } from "@shared/types/plugin";
import {
  homeHasSettings,
  pluginHasSettings,
  resolvePluginSettingsTarget,
  setupHomeOf,
} from "../pluginSettingsHome";

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
    blocklisted: false,
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

describe("plugin settings destinations beyond a key (#14101)", () => {
  const VIEW = {
    id: "prefs",
    componentPath: "dist/prefs.js",
    location: "settings" as const,
    pages: [{ id: "columns", title: "Columns" }],
  };

  it("sends a section to the one home that shows it", () => {
    const installed = plugin("global", {
      account: { kind: "token", label: "Acme" },
      setup: SETUP,
      settings: [{ id: "team", type: "string", scope: "project" }],
    });
    expect(
      resolvePluginSettingsTarget("acme.t", undefined, [installed], "proj-1", {
        section: "account",
        scope: "project",
      })
    ).toEqual({ ok: true, target: { plugin: installed, home: "manager", section: "account" } });
    expect(
      resolvePluginSettingsTarget("acme.t", undefined, [installed], null, { section: "setup" })
    ).toEqual({ ok: true, target: { plugin: installed, home: "manager", section: "setup" } });
  });

  it("opens an installed plugin's custom section in the home its scope names", () => {
    const installed = plugin("global", { views: [VIEW] });
    const at = (scope: "user" | "project" | undefined, projectId: string | null) =>
      resolvePluginSettingsTarget("acme.t", undefined, [installed], projectId, {
        section: "custom",
        page: "columns",
        ...(scope ? { scope } : {}),
      });
    expect(at("project", "proj-1")).toEqual({
      ok: true,
      target: { plugin: installed, home: "project", section: "custom", page: "columns" },
    });
    expect(at(undefined, "proj-1")).toMatchObject({ ok: true, target: { home: "manager" } });
    expect(at("project", null)).toEqual({ ok: false, reason: "needs-project" });
  });

  it("drops a section the plugin lacks and a page it doesn't declare", () => {
    const installed = plugin("global", { views: [VIEW] });
    expect(
      resolvePluginSettingsTarget("acme.t", undefined, [installed], null, { section: "account" })
    ).toEqual({ ok: true, target: { plugin: installed, home: "manager" } });
    expect(
      resolvePluginSettingsTarget("acme.t", undefined, [installed], null, {
        section: "custom",
        page: "nope",
      })
    ).toEqual({ ok: true, target: { plugin: installed, home: "manager", section: "custom" } });
  });

  it("lets a declared key win over a section", () => {
    const installed = plugin("global", {
      account: { kind: "token", label: "Acme" },
      settings: [{ id: "team", type: "string", scope: "project" }],
    });
    expect(
      resolvePluginSettingsTarget("acme.t", "team", [installed], "proj-1", { section: "account" })
    ).toEqual({ ok: true, target: { plugin: installed, home: "project", key: "team" } });
  });

  it("reads the whole plugin into homeHasSettings", () => {
    const viewOnly = plugin("global", { views: [VIEW] });
    expect(homeHasSettings(viewOnly, "manager")).toBe(true);
    expect(homeHasSettings(viewOnly, "project")).toBe(true);
    const accountOnly = plugin("project", { account: { kind: "token", label: "Acme" } });
    expect(homeHasSettings(accountOnly, "manager")).toBe(false);
    expect(homeHasSettings(accountOnly, "project")).toBe(true);
  });
});

describe("plugin settings for a per-project package (#14255)", () => {
  it("resolves the package id to this project's instance, never the package row", () => {
    const settings = { settings: [{ id: "team", type: "string" as const }] };
    const catalog: LoadedPluginInfo = {
      ...plugin("global", settings),
      instanceMode: "project",
      enabledInProjects: ["proj-1"],
    };
    const instance: LoadedPluginInfo = {
      ...plugin("project", settings),
      instanceId: "project__proj-1__installed__acme.t",
    };

    const resolved = resolvePluginSettingsTarget(
      "acme.t",
      undefined,
      [catalog, instance],
      "proj-1"
    );

    expect(resolved).toEqual({ ok: true, target: expect.objectContaining({ plugin: instance }) });
  });
});
