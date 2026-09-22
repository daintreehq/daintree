import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type { PluginManifest, SettingDefinition } from "../../../shared/types/plugin.js";
import type { SecretCipher } from "../plugin/secretCipher.js";

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProject: vi.fn((): { id?: string; path: string } | null => null),
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
      fileEditors: [],
      agents: [],
      processTools: [],
      recipes: [],
      settings,
    },
  };
}

/** Reversible fake keychain; `available: false` is a host with no OS keychain. */
function fakeCipher(available = true): SecretCipher {
  return {
    tier: () => (available ? "keychain" : "unavailable"),
    encrypt: (plaintext) =>
      available ? Buffer.from(`enc:${plaintext}`, "utf-8").toString("base64") : null,
    decrypt: (c) => Buffer.from(c, "base64").toString("utf-8").slice("enc:".length),
  };
}

function managerFor(
  settings: SettingDefinition[],
  cipher: SecretCipher = fakeCipher()
): InstanceType<typeof PluginSettingsManager> {
  const manifest = manifestWith(settings);
  return new PluginSettingsManager({
    getPluginsRoot: () => path.join(tmpDir, "plugins"),
    // A project plugin's instance key (`project__<id>__<name>`) resolves to the
    // same manifest, as it does in the real plugin registry.
    getManifest: (id) =>
      id === manifest.name || id.endsWith(`__${manifest.name}`) ? manifest : undefined,
    cipher,
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
    expect(ui.secretTier).toBe("keychain");
    expect(ui.secretsPlaintext).toEqual([]);
  });

  it("discloses an unavailable keychain and refuses the write", async () => {
    const mgr = managerFor([{ id: "token", type: "secret", scope: "user" }], fakeCipher(false));
    await expect(
      mgr.setSettingValueFromUi("acme.scope-test", "token", "sk-1", "user", null)
    ).rejects.toThrow(/Secure storage is unavailable/);
    const ui = await mgr.getSettingValuesForUi("acme.scope-test", "user", null);
    expect(ui.secretTier).toBe("unavailable");
    expect(ui.secretsSet).toEqual([]);
  });

  it("flags a legacy plaintext secret so the form can nudge a re-save", async () => {
    const mgr = managerFor([{ id: "token", type: "secret", scope: "user" }]);
    await fs.mkdir(path.join(tmpDir, "plugin-settings"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "plugin-settings", "acme.scope-test.json"),
      JSON.stringify({ token: "sk-legacy" })
    );
    const ui = await mgr.getSettingValuesForUi("acme.scope-test", "user", null);
    expect(ui.secretsSet).toEqual(["token"]);
    expect(ui.secretsPlaintext).toEqual(["token"]);
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

describe("PluginSettingsManager local scope", () => {
  const PROJECT_ID = "a".repeat(64);
  const OTHER_PROJECT_ID = "b".repeat(64);

  it("writes outside the repository, under this machine's own settings root", async () => {
    const mgr = managerFor([{ id: "interpreter", type: "string", scope: "local" }]);
    projectStoreMock.getProjectById.mockReturnValue({ path: "/tmp/some-checkout" });

    await mgr.setSettingValueFromUi(
      "acme.scope-test",
      "interpreter",
      "/usr/bin/python3",
      "local",
      PROJECT_ID
    );

    const file = path.join(tmpDir, "plugin-settings", "local", PROJECT_ID, "acme.scope-test.json");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
      interpreter: "/usr/bin/python3",
    });
    // Nothing was written under the project root — that is the whole point of
    // the scope, and a "project"-scoped write is what would land there.
    await expect(fs.access("/tmp/some-checkout/.daintree")).rejects.toThrow();
  });

  it("keeps each project's value separate", async () => {
    const mgr = managerFor([{ id: "interpreter", type: "string", scope: "local" }]);

    await mgr.setSettingValueFromUi("acme.scope-test", "interpreter", "/a", "local", PROJECT_ID);
    await mgr.setSettingValueFromUi(
      "acme.scope-test",
      "interpreter",
      "/b",
      "local",
      OTHER_PROJECT_ID
    );

    const a = await mgr.getSettingValuesForUi("acme.scope-test", "local", PROJECT_ID);
    const b = await mgr.getSettingValuesForUi("acme.scope-test", "local", OTHER_PROJECT_ID);
    expect(a.values).toEqual({ interpreter: "/a" });
    expect(b.values).toEqual({ interpreter: "/b" });
  });

  it("gives a project plugin its own file rather than sharing an installed plugin's", () => {
    const mgr = managerFor([]);
    const installed = mgr.resolveSettingsFilePath("acme.scope-test", "local");
    const projectOwned = mgr.resolveSettingsFilePath(
      `project__${PROJECT_ID}__acme.scope-test`,
      "local"
    );
    // Same manifest id, two different plugins. With no repository to isolate
    // them, only the file name can.
    expect(projectOwned).toBeDefined();
    expect(projectOwned).not.toBe(installed);
  });

  it("pins a project plugin to its own project", async () => {
    const mgr = managerFor([{ id: "interpreter", type: "string", scope: "local" }]);
    await expect(
      mgr.getSettingValuesForUi(
        `project__${PROJECT_ID}__acme.scope-test`,
        "local",
        OTHER_PROJECT_ID
      )
    ).rejects.toThrow(/belongs to a different project/);
  });

  it("has no target without a project, exactly like project scope", async () => {
    const mgr = managerFor([{ id: "interpreter", type: "string", scope: "local" }]);
    const values = await mgr.getSettingValuesForUi("acme.scope-test", "local", null);
    expect(values.values).toEqual({});
    await expect(
      mgr.setSettingValueFromUi("acme.scope-test", "interpreter", "/x", "local", null)
    ).rejects.toThrow(/no active project/);
  });

  it("refuses a project id that is not a project workspace id", async () => {
    const mgr = managerFor([{ id: "interpreter", type: "string", scope: "local" }]);
    await expect(
      mgr.setSettingValueFromUi("acme.scope-test", "interpreter", "/x", "local", "../escape")
    ).rejects.toThrow(/no active project/);
  });

  it("enforces the declared scope in both directions", async () => {
    const mgr = managerFor([{ id: "interpreter", type: "string", scope: "local" }]);
    expect(mgr.getDeclaredScope("acme.scope-test", "interpreter")).toBe("local");
    await expect(
      mgr.setSettingValueFromUi("acme.scope-test", "interpreter", "/x", "project", PROJECT_ID)
    ).rejects.toThrow(/declared in "local" scope, not "project"/);
    await expect(
      mgr.setSettingValueFromUi("acme.scope-test", "interpreter", "/x", "user", null)
    ).rejects.toThrow(/declared in "local" scope, not "user"/);
  });

  it("only surfaces local-scoped declarations to the local form section", async () => {
    const mgr = managerFor([
      { id: "interpreter", type: "string", scope: "local" },
      { id: "ref", type: "string", scope: "project" },
    ]);
    projectStoreMock.getProjectById.mockReturnValue({ path: tmpDir });

    await mgr.setSettingValueFromUi("acme.scope-test", "interpreter", "/a", "local", PROJECT_ID);
    await mgr.setSettingValueFromUi("acme.scope-test", "ref", "origin", "project", PROJECT_ID);

    expect(
      (await mgr.getSettingValuesForUi("acme.scope-test", "local", PROJECT_ID)).values
    ).toEqual({ interpreter: "/a" });
    expect(
      (await mgr.getSettingValuesForUi("acme.scope-test", "project", PROJECT_ID)).values
    ).toEqual({ ref: "origin" });
  });
});

/** Every file's contents under `dir`, concatenated — empty when nothing was written there. */
async function contentsUnder(dir: string): Promise<string> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { recursive: true })) as string[];
  } catch {
    return "";
  }
  const chunks: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if ((await fs.stat(full)).isFile()) chunks.push(await fs.readFile(full, "utf8"));
  }
  return chunks.join("\n");
}

describe("PluginSettingsManager project-scoped secrets (#12613)", () => {
  const PROJECT_ID = "a".repeat(64);
  const OTHER_PROJECT_ID = "b".repeat(64);
  const PLUGIN_ID = "acme.scope-test";
  const SETTINGS: SettingDefinition[] = [
    { id: "token", type: "secret", scope: "project" },
    { id: "ref", type: "string", scope: "project" },
  ];
  let projectRoot: string;

  const localFile = (pluginId = PLUGIN_ID) =>
    path.join(tmpDir, "plugin-settings", "local", PROJECT_ID, `${pluginId}.json`);
  const repoFile = () =>
    path.join(projectRoot, ".daintree", "plugin-settings", `${PLUGIN_ID}.json`);

  beforeEach(() => {
    projectRoot = path.join(tmpDir, "checkout");
    projectStoreMock.getProjectById.mockImplementation((id) =>
      id === PROJECT_ID ? { path: projectRoot } : null
    );
    projectStoreMock.getCurrentProject.mockReturnValue(null);
  });

  it("stores the secret in this machine's local file and the rest in the repository", async () => {
    const mgr = managerFor(SETTINGS);
    await mgr.setSettingValueFromUi(PLUGIN_ID, "token", "sk-project-1", "project", PROJECT_ID);
    await mgr.setSettingValueFromUi(PLUGIN_ID, "ref", "origin", "project", PROJECT_ID);

    expect(JSON.parse(await fs.readFile(repoFile(), "utf8"))).toEqual({ ref: "origin" });
    const local = JSON.parse(await fs.readFile(localFile(), "utf8")) as Record<string, unknown>;
    expect(local.token).toMatchObject({ __daintreeSecret: "daintree:secret:v1" });

    const underRoot = await contentsUnder(projectRoot);
    expect(underRoot).not.toContain("sk-project-1");
    expect(underRoot).not.toContain("daintree:secret");
  });

  it("still reads, reveals, and clears the secret as a project setting", async () => {
    const mgr = managerFor(SETTINGS);
    const cb = vi.fn();
    mgr.addSubscriber(PLUGIN_ID, { key: "token", scope: "project", cb });
    await mgr.setSettingValueFromUi(PLUGIN_ID, "token", "sk-project-1", "project", PROJECT_ID);
    await mgr.setSettingValueFromUi(PLUGIN_ID, "ref", "origin", "project", PROJECT_ID);
    expect(cb).toHaveBeenLastCalledWith("sk-project-1");

    const ui = await mgr.getSettingValuesForUi(PLUGIN_ID, "project", PROJECT_ID);
    expect(ui.values).toEqual({ ref: "origin" });
    expect(ui.secretsSet).toEqual(["token"]);
    expect(await mgr.revealSecretSettingForUi(PLUGIN_ID, "token", "project", PROJECT_ID)).toBe(
      "sk-project-1"
    );
    // Stored beside local settings, but never surfaced in the local section.
    expect(await mgr.getSettingValuesForUi(PLUGIN_ID, "local", PROJECT_ID)).toMatchObject({
      values: {},
      secretsSet: [],
    });

    expect(await mgr.deleteSettingValueFromUi(PLUGIN_ID, "token", "project", PROJECT_ID)).toBe(
      true
    );
    expect(cb).toHaveBeenLastCalledWith(undefined);
    expect(JSON.parse(await fs.readFile(localFile(), "utf8"))).toEqual({});
  });

  it("refuses the secret with no keychain and leaves nothing of it under the project root", async () => {
    const mgr = managerFor(SETTINGS, fakeCipher(false));
    await expect(
      mgr.setSettingValueFromUi(PLUGIN_ID, "token", "sk-project-1", "project", PROJECT_ID)
    ).rejects.toThrow(/Secure storage is unavailable/);
    // An ordinary project write afterwards must not carry the refused value
    // into the repository file either.
    await mgr.setSettingValueFromUi(PLUGIN_ID, "ref", "origin", "project", PROJECT_ID);

    const underRoot = await contentsUnder(projectRoot);
    expect(underRoot).not.toContain("sk-project-1");
    expect(underRoot).not.toContain("daintree:secret");
    await expect(fs.access(localFile())).rejects.toThrow();

    const ui = await mgr.getSettingValuesForUi(PLUGIN_ID, "project", PROJECT_ID);
    expect(ui.secretTier).toBe("unavailable");
    expect(ui.secretsSet).toEqual([]);
  });

  it("shares one store with the plugin's local settings, so neither write erases the other", async () => {
    const mgr = managerFor([...SETTINGS, { id: "interpreter", type: "string", scope: "local" }]);
    await Promise.all([
      mgr.setSettingValueFromUi(PLUGIN_ID, "interpreter", "/usr/bin/python3", "local", PROJECT_ID),
      mgr.setSettingValueFromUi(PLUGIN_ID, "token", "sk-project-1", "project", PROJECT_ID),
    ]);
    const local = JSON.parse(await fs.readFile(localFile(), "utf8")) as Record<string, unknown>;
    expect(local.interpreter).toBe("/usr/bin/python3");
    expect(local.token).toMatchObject({ __daintreeSecret: "daintree:secret:v1" });
  });

  it("ignores a secret an older Daintree left in the repository file", async () => {
    await fs.mkdir(path.dirname(repoFile()), { recursive: true });
    await fs.writeFile(repoFile(), JSON.stringify({ token: "sk-committed", ref: "origin" }));
    const mgr = managerFor(SETTINGS);

    const ui = await mgr.getSettingValuesForUi(PLUGIN_ID, "project", PROJECT_ID);
    expect(ui.values).toEqual({ ref: "origin" });
    expect(ui.secretsSet).toEqual([]);
    expect(await mgr.revealSecretSettingForUi(PLUGIN_ID, "token", "project", PROJECT_ID)).toBe(
      null
    );
  });

  it("resolves the host's secret file through the same authority", () => {
    const mgr = managerFor(SETTINGS);
    const instance = `project__${PROJECT_ID}__${PLUGIN_ID}`;
    projectStoreMock.getCurrentProject.mockReturnValue({ id: PROJECT_ID, path: projectRoot });

    // Unbound: the active project, like every other project-scope call.
    expect(mgr.resolveSettingsFilePathForKey(PLUGIN_ID, "token", "project")).toBe(localFile());
    expect(mgr.resolveSettingsFilePathForKey(PLUGIN_ID, "ref", "project")).toBe(repoFile());

    // Bound: the instance key names the project; the active one is never read.
    projectStoreMock.getCurrentProject.mockReturnValue({
      id: OTHER_PROJECT_ID,
      path: path.join(tmpDir, "other"),
    });
    expect(mgr.resolveSettingsFilePathForKey(instance, "token", "project", projectRoot)).toBe(
      localFile(instance)
    );
    // A bound host with no instance key has no project id to key the file by,
    // so the secret has no target rather than landing in the active project's.
    expect(
      mgr.resolveSettingsFilePathForKey(PLUGIN_ID, "token", "project", projectRoot)
    ).toBeUndefined();
  });
});
