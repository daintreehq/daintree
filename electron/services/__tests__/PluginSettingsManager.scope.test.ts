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
      skills: [],
      forgeProviders: [],
      fileDecorationProviders: [],
      agents: [],
      processTools: [],
      recipes: [],
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

  it("getDeclaredScope resolves the declared scope, defaulting to user, and undefined for undeclared keys (#10586)", () => {
    const mgr = managerFor([
      { id: "ref", type: "string", scope: "project" },
      { id: "token", type: "string", scope: "user" },
      { id: "implicit", type: "string" },
    ]);
    expect(mgr.getDeclaredScope("acme.scope-test", "ref")).toBe("project");
    expect(mgr.getDeclaredScope("acme.scope-test", "token")).toBe("user");
    // No explicit scope on the declaration defaults to "user".
    expect(mgr.getDeclaredScope("acme.scope-test", "implicit")).toBe("user");
    // Undeclared key — undefined so the read path keeps its permissive fallback.
    expect(mgr.getDeclaredScope("acme.scope-test", "missing")).toBeUndefined();
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

describe("PluginSettingsManager secret tier routing (#9167)", () => {
  // safeStorage is absent under vitest, so the default cipher reports the
  // plaintext fallback tier — exercising the fallback wiring end-to-end through
  // the manager (the encrypted path is covered with an injected cipher in
  // PluginSettingsStore.secret.test.ts).
  it("masks a stored secret, reports it set, and discloses the at-rest tier", async () => {
    const mgr = managerFor([
      { id: "token", type: "secret", scope: "user" },
      { id: "endpoint", type: "string", scope: "user" },
    ]);

    await mgr.setSettingValueFromUi("acme.scope-test", "token", "sk-1", "user", null);
    await mgr.setSettingValueFromUi("acme.scope-test", "endpoint", "https://x", "user", null);

    const ui = await mgr.getSettingValuesForUi("acme.scope-test", "user", null);
    // The secret value is never returned by value, only its id in secretsSet.
    expect(ui.values).not.toHaveProperty("token");
    expect(ui.secretsSet).toContain("token");
    expect(ui.values.endpoint).toBe("https://x");
    // Tier is disclosed; with no keychain the fallback is plaintext and the
    // stored value is flagged as plaintext.
    expect(ui.secretTier).toBe("plaintext");
    expect(ui.secretsPlaintext).toContain("token");
  });

  it("reveals a stored secret only through the explicit reveal path", async () => {
    const mgr = managerFor([{ id: "token", type: "secret", scope: "user" }]);
    await mgr.setSettingValueFromUi("acme.scope-test", "token", "sk-secret", "user", null);
    expect(await mgr.revealSecretSettingForUi("acme.scope-test", "token", "user", null)).toBe(
      "sk-secret"
    );
  });

  it("isSecretKey reflects the declared type and the legacy secret flag", () => {
    const mgr = managerFor([
      { id: "typed", type: "secret" },
      { id: "legacy", type: "string", secret: true },
      { id: "plain", type: "string" },
    ]);
    expect(mgr.isSecretKey("acme.scope-test", "typed")).toBe(true);
    expect(mgr.isSecretKey("acme.scope-test", "legacy")).toBe(true);
    expect(mgr.isSecretKey("acme.scope-test", "plain")).toBe(false);
    expect(mgr.isSecretKey("acme.scope-test", "undeclared")).toBe(false);
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

describe("PluginSettingsManager onDidChange failure isolation (#10621)", () => {
  it("quarantines a subscriber that throws on 3 consecutive notifications", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mgr = managerFor([{ id: "token", type: "string", scope: "user" }]);
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    mgr.addSubscriber("acme.scope-test", { key: "token", scope: "user", cb: bad });

    for (let i = 0; i < 3; i++) {
      mgr.notifySettingsSubscribers("acme.scope-test", "user", "token", `v${i}`);
    }
    expect(bad).toHaveBeenCalledTimes(3);

    // A 4th notify no longer reaches the auto-unsubscribed callback.
    mgr.notifySettingsSubscribers("acme.scope-test", "user", "token", "v3");
    expect(bad).toHaveBeenCalledTimes(3);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("does not quarantine a subscriber that recovers between throws", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mgr = managerFor([{ id: "token", type: "string", scope: "user" }]);
    let shouldThrow = true;
    const cb = vi.fn(() => {
      if (shouldThrow) throw new Error("intermittent");
    });
    mgr.addSubscriber("acme.scope-test", { key: "token", scope: "user", cb });

    mgr.notifySettingsSubscribers("acme.scope-test", "user", "token", "a");
    mgr.notifySettingsSubscribers("acme.scope-test", "user", "token", "b");
    shouldThrow = false;
    mgr.notifySettingsSubscribers("acme.scope-test", "user", "token", "c");
    shouldThrow = true;
    mgr.notifySettingsSubscribers("acme.scope-test", "user", "token", "d");
    mgr.notifySettingsSubscribers("acme.scope-test", "user", "token", "e");

    // Still subscribed: a final delivery fires.
    shouldThrow = false;
    mgr.notifySettingsSubscribers("acme.scope-test", "user", "token", "f");
    expect(cb).toHaveBeenCalledTimes(6);
    expect(cb).toHaveBeenLastCalledWith("f");

    errorSpy.mockRestore();
  });
});
