import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type { PluginManifest, SettingDefinition } from "../../../shared/types/plugin.js";

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProject: vi.fn((): { path: string } | null => null),
  getProjectById: vi.fn((_id: string): { path: string } | null => null),
}));

vi.mock("../ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const { PluginSettingsManager } = await import("../plugin/PluginSettingsManager.js");

let tmpDir: string;

function manifestWith(settings: SettingDefinition[]): PluginManifest {
  return {
    name: "acme.scope-test",
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
      forgeProviders: [],
      fileDecorationProviders: [],
      agents: [],
      settings,
    },
  };
}

function managerFor(settings: SettingDefinition[]): InstanceType<typeof PluginSettingsManager> {
  const manifest = manifestWith(settings);
  return new PluginSettingsManager({
    getPluginsRoot: () => path.join(tmpDir, "plugins"),
    getManifest: (id) => (id === manifest.name ? manifest : undefined),
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-scope-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("PluginSettingsManager declared-scope enforcement", () => {
  it("rejects writing a user-scoped key under project scope (UI bridge)", async () => {
    const mgr = managerFor([{ id: "token", type: "string", scope: "user" }]);
    await expect(
      mgr.setSettingValueFromUi("acme.scope-test", "token", "x", "project", "proj-1")
    ).rejects.toThrow(/declared in "user" scope, not "project"/);
  });

  it("rejects writing a project-scoped key under user scope (UI bridge)", async () => {
    const mgr = managerFor([{ id: "ref", type: "string", scope: "project" }]);
    await expect(
      mgr.setSettingValueFromUi("acme.scope-test", "ref", "x", "user", null)
    ).rejects.toThrow(/declared in "project" scope, not "user"/);
  });

  it("rejects deleting a cross-scope declared key (UI bridge)", async () => {
    const mgr = managerFor([{ id: "token", type: "string", scope: "user" }]);
    await expect(
      mgr.deleteSettingValueFromUi("acme.scope-test", "token", "project", "proj-1")
    ).rejects.toThrow(/declared in "user" scope, not "project"/);
  });

  it("assertSettingDeclared accepts a matching scope and a default (user) scope", () => {
    const mgr = managerFor([
      { id: "token", type: "string", scope: "user" },
      { id: "implicit", type: "string" },
    ]);
    expect(() => mgr.assertSettingDeclared("acme.scope-test", "token", "user")).not.toThrow();
    expect(() => mgr.assertSettingDeclared("acme.scope-test", "implicit", "user")).not.toThrow();
    expect(() => mgr.assertSettingDeclared("acme.scope-test", "implicit", "project")).toThrow(
      /declared in "user" scope, not "project"/
    );
  });

  it("assertSettingScope rejects a cross-scope onDidChange but ignores undeclared keys", () => {
    const mgr = managerFor([{ id: "ref", type: "string", scope: "project" }]);
    expect(() => mgr.assertSettingScope("acme.scope-test", "ref", "user")).toThrow(
      /settings\.onDidChange: key "ref" is declared in "project" scope, not "user"/
    );
    expect(() => mgr.assertSettingScope("acme.scope-test", "ref", "project")).not.toThrow();
    // Undeclared key — no scope to enforce.
    expect(() => mgr.assertSettingScope("acme.scope-test", "other", "user")).not.toThrow();
  });

  it("accepts any key when contributes.settings is an empty array", () => {
    const mgr = managerFor([]);
    expect(() => mgr.assertSettingDeclared("acme.scope-test", "anything", "project")).not.toThrow();
    expect(() => mgr.assertSettingScope("acme.scope-test", "anything", "project")).not.toThrow();
  });

  it("accepts any key when contributes.settings is absent", () => {
    const manifest = manifestWith([]);
    delete manifest.contributes.settings;
    const mgr = new PluginSettingsManager({
      getPluginsRoot: () => path.join(tmpDir, "plugins"),
      getManifest: (id) => (id === manifest.name ? manifest : undefined),
    });
    expect(() => mgr.assertSettingDeclared("acme.scope-test", "anything", "project")).not.toThrow();
    expect(() => mgr.assertSettingScope("acme.scope-test", "anything", "project")).not.toThrow();
  });
});

describe("PluginSettingsManager subscriber cleanup on unload (#10477)", () => {
  it("drops a plugin's onDidChange subscribers when its settings state is cleared", () => {
    const mgr = managerFor([{ id: "token", type: "string", scope: "user" }]);
    const cb = vi.fn();
    mgr.addSubscriber("acme.scope-test", { key: "token", scope: "user", cb });

    // Before cleanup the subscriber fires. Signature is (pluginId, scope, key, value).
    mgr.notifySettingsSubscribers("acme.scope-test", "user", "token", "v1");
    expect(cb).toHaveBeenCalledTimes(1);

    // clearPluginSettingsState is the belt-and-suspenders step unloadPlugin runs
    // to guarantee no subscriber outlives the plugin.
    mgr.clearPluginSettingsState("acme.scope-test");

    // The plugin's subscriber set is gone, and a later notify is a no-op.
    expect(
      (mgr as unknown as { settingsSubscribers: Map<string, unknown> }).settingsSubscribers.has(
        "acme.scope-test"
      )
    ).toBe(false);
    mgr.notifySettingsSubscribers("acme.scope-test", "user", "token", "v2");
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
