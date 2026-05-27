import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

const appMock = vi.hoisted(() => ({
  getVersion: vi.fn(() => "0.0.0"),
}));
const broadcastToRendererMock = vi.hoisted(() => vi.fn());
const storeMock = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => state.get(key)),
    set: vi.fn((key: string, value: unknown) => state.set(key, value)),
    _state: state,
  };
});
const getCurrentProjectMock = vi.hoisted(() => vi.fn<() => { path: string } | null>(() => null));

vi.mock("electron", () => ({
  app: appMock,
}));
vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: broadcastToRendererMock,
}));
vi.mock("../../store.js", () => ({
  store: storeMock,
}));
vi.mock("../../../shared/config/panelKindRegistry.js", () => ({
  registerPanelKind: vi.fn(),
  unregisterPluginPanelKinds: vi.fn(),
  onPanelKindRegistered: vi.fn(() => () => {}),
  onPanelKindUnregistered: vi.fn(() => () => {}),
  getPluginPanelKinds: vi.fn(() => []),
}));
vi.mock("../../../shared/config/toolbarButtonRegistry.js", () => ({
  registerToolbarButton: vi.fn(),
  unregisterPluginToolbarButtons: vi.fn(),
  getAllPluginToolbarButtonConfigs: vi.fn(() => []),
}));
vi.mock("../pluginMenuRegistry.js", () => ({
  registerPluginMenuItem: vi.fn(),
  unregisterPluginMenuItems: vi.fn(),
}));
vi.mock("../forgeProviderRegistry.js", () => ({
  registerForgeProviders: vi.fn(),
  unregisterForgeProviders: vi.fn(),
  registerForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpls: vi.fn(),
  getForgeProviderImpl: vi.fn(),
  clearForgeProviderImplRegistry: vi.fn(),
}));
vi.mock("../ProjectStore.js", () => ({
  projectStore: { getCurrentProject: getCurrentProjectMock },
}));

import { PluginService } from "../PluginService.js";
import { PluginManifestSchema } from "../../schemas/plugin.js";

type SettingsScope = "user" | "project";
interface SettingsHost {
  pluginId: string;
  settings: {
    get: <T>(key: string, options?: { scope?: SettingsScope }) => Promise<T | undefined>;
    set: <T>(key: string, value: T, options?: { scope?: SettingsScope }) => Promise<void>;
    onDidChange: <T>(
      key: string,
      callback: (value: T | undefined) => void,
      options?: { scope?: SettingsScope }
    ) => () => void;
  };
}
type CreateHostShape = (id: string) => { host: SettingsHost; revoke: () => void };

const PLUGIN_ID = "acme.settings-host";

function settingsManifest(keys: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    name: PLUGIN_ID,
    version: "1.0.0",
    contributes: { settings: keys },
  };
}

function writePlugin(dirName: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(pluginsDir, dirName);
  return fs
    .mkdir(dir, { recursive: true })
    .then(() => fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest)));
}

async function makeHost(
  keys: Array<Record<string, unknown>> = [{ key: "apiKey", type: "string" }]
): Promise<{ service: PluginService; host: SettingsHost }> {
  await writePlugin("settings-host", settingsManifest(keys));
  const service = new PluginService(pluginsDir);
  await service.initialize();
  const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(PLUGIN_ID);
  return { service, host };
}

let tmpDir: string;
let pluginsDir: string;
let homeDir: string;
let projectDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-settings-"));
  pluginsDir = path.join(tmpDir, "plugins");
  homeDir = path.join(tmpDir, "home");
  projectDir = path.join(tmpDir, "project");
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  vi.clearAllMocks();
  storeMock._state.clear();
  getCurrentProjectMock.mockReturnValue(null);
  vi.spyOn(os, "homedir").mockReturnValue(homeDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("PluginManifestSchema — contributes.settings", () => {
  it("accepts a settings contribution array", () => {
    const result = PluginManifestSchema.safeParse({
      name: PLUGIN_ID,
      version: "1.0.0",
      contributes: {
        settings: [{ key: "apiKey", type: "string", description: "API key", secret: true }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.settings).toEqual([
        { key: "apiKey", type: "string", description: "API key", secret: true },
      ]);
    }
  });

  it("defaults settings to an empty array when omitted", () => {
    const result = PluginManifestSchema.safeParse({ name: PLUGIN_ID, version: "1.0.0" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.contributes.settings).toEqual([]);
  });

  it("rejects an unknown field on a setting", () => {
    const result = PluginManifestSchema.safeParse({
      name: PLUGIN_ID,
      version: "1.0.0",
      contributes: { settings: [{ key: "apiKey", type: "string", bogus: true }] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid setting type", () => {
    const result = PluginManifestSchema.safeParse({
      name: PLUGIN_ID,
      version: "1.0.0",
      contributes: { settings: [{ key: "apiKey", type: "date" }] },
    });
    expect(result.success).toBe(false);
  });
});

describe("host.settings — user scope", () => {
  it("set then get round-trips a value", async () => {
    const { host } = await makeHost();
    await host.settings.set("apiKey", "abc123");
    expect(await host.settings.get<string>("apiKey")).toBe("abc123");
  });

  it("get returns undefined for an unset key", async () => {
    const { host } = await makeHost([
      { key: "apiKey", type: "string" },
      { key: "other", type: "string" },
    ]);
    expect(await host.settings.get<string>("other")).toBeUndefined();
  });

  it("persists to ~/.daintree/plugin-settings/{pluginId}.json", async () => {
    const { host } = await makeHost();
    await host.settings.set("apiKey", "v");
    const filePath = path.join(homeDir, ".daintree", "plugin-settings", `${PLUGIN_ID}.json`);
    const raw = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual({ apiKey: "v" });
  });

  it.runIf(process.platform !== "win32")("writes the file with 0o600 perms", async () => {
    const { host } = await makeHost();
    await host.settings.set("apiKey", "v");
    const filePath = path.join(homeDir, ".daintree", "plugin-settings", `${PLUGIN_ID}.json`);
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("round-trips object and boolean values", async () => {
    const { host } = await makeHost([
      { key: "config", type: "object" },
      { key: "enabled", type: "boolean" },
    ]);
    await host.settings.set("config", { a: 1, nested: { b: true } });
    await host.settings.set("enabled", false);
    expect(await host.settings.get("config")).toEqual({ a: 1, nested: { b: true } });
    expect(await host.settings.get<boolean>("enabled")).toBe(false);
  });

  it("rejects a key not declared in contributes.settings", async () => {
    const { host } = await makeHost();
    await expect(host.settings.set("undeclared", "x")).rejects.toThrow(
      /not declared in contributes\.settings/
    );
  });

  it("rejects an undefined value", async () => {
    const { host } = await makeHost();
    await expect(host.settings.set("apiKey", undefined as unknown as string)).rejects.toThrow(
      /must not be undefined/
    );
  });

  it("throws when the settings file contains corrupt JSON", async () => {
    const { host } = await makeHost();
    const filePath = path.join(homeDir, ".daintree", "plugin-settings", `${PLUGIN_ID}.json`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ not json");
    await expect(host.settings.get("apiKey")).rejects.toThrow(/Failed to parse/);
  });
});

describe("host.settings — project scope", () => {
  it("get returns undefined when no project is active", async () => {
    const { host } = await makeHost();
    getCurrentProjectMock.mockReturnValue(null);
    expect(await host.settings.get("apiKey", { scope: "project" })).toBeUndefined();
  });

  it("set rejects when no project is active", async () => {
    const { host } = await makeHost();
    getCurrentProjectMock.mockReturnValue(null);
    await expect(host.settings.set("apiKey", "v", { scope: "project" })).rejects.toThrow(
      /no active project/
    );
  });

  it("set then get round-trips within the active project dir", async () => {
    const { host } = await makeHost();
    getCurrentProjectMock.mockReturnValue({ path: projectDir });
    await host.settings.set("apiKey", "proj-value", { scope: "project" });
    expect(await host.settings.get<string>("apiKey", { scope: "project" })).toBe("proj-value");
    const filePath = path.join(projectDir, ".daintree", "plugin-settings", `${PLUGIN_ID}.json`);
    expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual({ apiKey: "proj-value" });
  });

  it("keeps user and project scopes independent", async () => {
    const { host } = await makeHost();
    getCurrentProjectMock.mockReturnValue({ path: projectDir });
    await host.settings.set("apiKey", "user-val", { scope: "user" });
    await host.settings.set("apiKey", "proj-val", { scope: "project" });
    expect(await host.settings.get<string>("apiKey", { scope: "user" })).toBe("user-val");
    expect(await host.settings.get<string>("apiKey", { scope: "project" })).toBe("proj-val");
  });
});

describe("host.settings.onDidChange", () => {
  it("fires the callback after set with the new value", async () => {
    const { host } = await makeHost();
    const cb = vi.fn();
    host.settings.onDidChange<string>("apiKey", cb);
    await host.settings.set("apiKey", "new");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("new");
  });

  it("fires all listeners registered on the same key", async () => {
    const { host } = await makeHost();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    host.settings.onDidChange("apiKey", cb1);
    host.settings.onDidChange("apiKey", cb2);
    await host.settings.set("apiKey", "v");
    expect(cb1).toHaveBeenCalledWith("v");
    expect(cb2).toHaveBeenCalledWith("v");
  });

  it("disposer stops further callbacks and is idempotent", async () => {
    const { host } = await makeHost();
    const cb = vi.fn();
    const dispose = host.settings.onDidChange("apiKey", cb);
    dispose();
    dispose();
    await host.settings.set("apiKey", "v");
    expect(cb).not.toHaveBeenCalled();
  });

  it("does not fire a user-scope listener on a project-scope write", async () => {
    const { host } = await makeHost();
    getCurrentProjectMock.mockReturnValue({ path: projectDir });
    const cb = vi.fn();
    host.settings.onDidChange("apiKey", cb, { scope: "user" });
    await host.settings.set("apiKey", "v", { scope: "project" });
    expect(cb).not.toHaveBeenCalled();
  });

  it("auto-disposes listeners when the plugin is unloaded", async () => {
    const { service, host } = await makeHost();
    const cb = vi.fn();
    host.settings.onDidChange("apiKey", cb);
    service.unloadPlugin(PLUGIN_ID);
    const listeners = (service as unknown as { settingsListeners: Map<string, unknown> })
      .settingsListeners;
    expect(listeners.has(PLUGIN_ID)).toBe(false);
  });
});

describe("host.settings — unloaded plugin", () => {
  it("get returns undefined and set throws after unload", async () => {
    const { service, host } = await makeHost();
    service.unloadPlugin(PLUGIN_ID);
    expect(await host.settings.get("apiKey")).toBeUndefined();
    await expect(host.settings.set("apiKey", "v")).rejects.toThrow(/plugin is not loaded/);
  });
});
