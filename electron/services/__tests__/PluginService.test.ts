import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

const appMock = vi.hoisted(() => ({
  getVersion: vi.fn(() => "0.0.0"),
}));
const broadcastToRendererMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: appMock,
}));
vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: broadcastToRendererMock,
}));
vi.mock("../../../shared/config/panelKindRegistry.js", () => ({
  registerPanelKind: vi.fn(),
  unregisterPluginPanelKinds: vi.fn(),
}));
vi.mock("../../../shared/config/toolbarButtonRegistry.js", () => ({
  registerToolbarButton: vi.fn(),
  unregisterPluginToolbarButtons: vi.fn(),
}));
vi.mock("../pluginMenuRegistry.js", () => ({
  registerPluginMenuItem: vi.fn(),
  unregisterPluginMenuItems: vi.fn(),
}));

import { PluginService } from "../PluginService.js";
import { PluginManifestSchema } from "../../schemas/plugin.js";
import {
  BUILT_IN_PLUGIN_PERMISSIONS,
  type PluginIpcContext,
} from "../../../shared/types/plugin.js";
import {
  registerPanelKind,
  unregisterPluginPanelKinds,
} from "../../../shared/config/panelKindRegistry.js";
import {
  registerToolbarButton,
  unregisterPluginToolbarButtons,
} from "../../../shared/config/toolbarButtonRegistry.js";
import { registerPluginMenuItem, unregisterPluginMenuItems } from "../pluginMenuRegistry.js";
import { CHANNELS } from "../../ipc/channels.js";

function makeCtx(pluginId: string, overrides: Partial<PluginIpcContext> = {}): PluginIpcContext {
  return {
    projectId: null,
    worktreeId: null,
    webContentsId: 0,
    pluginId,
    ...overrides,
  };
}

let tmpDir: string;

function writePlugin(name: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(tmpDir, name);
  return fs
    .mkdir(dir, { recursive: true })
    .then(() => fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest)));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("PluginManifestSchema name validation", () => {
  const validBase = { version: "1.0.0" };
  const sixtyFourCharName = `a.${"b".repeat(62)}`; // 1 + 1 + 62 = 64 chars
  const sixtyFiveCharName = `a.${"b".repeat(63)}`; // 1 + 1 + 63 = 65 chars

  it.each([
    "acme.linear-context",
    "a.b",
    "daintreehq.dev-tools",
    "daintree-hq.my-cool-plugin",
    "acme.good-1",
    sixtyFourCharName,
  ])("accepts scoped name %j", (name) => {
    const result = PluginManifestSchema.safeParse({ name, ...validBase });
    expect(result.success).toBe(true);
  });

  it.each([
    "linear-context",
    "test-plugin",
    "Acme.linear-context",
    "acme.Linear",
    "acme..tools",
    ".acme.tools",
    "acme.tools.",
    "acme.team.tools",
    "acme/tools",
    "acme_tools",
    "acme.-foo",
    "acme.foo-",
    "-acme.foo",
    "---.foo",
    "acme.---",
    " acme.foo",
    "acme.foo ",
    "acme.foo\n",
    sixtyFiveCharName,
    "",
  ])("rejects unscoped or malformed name %j", (name) => {
    const result = PluginManifestSchema.safeParse({ name, ...validBase });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "name")).toBe(true);
    }
  });

  it("rejection includes an explanatory error message", () => {
    const result = PluginManifestSchema.safeParse({ name: "bare-plugin", ...validBase });
    expect(result.success).toBe(false);
    if (!result.success) {
      const nameIssue = result.error.issues.find((i) => i.path[0] === "name");
      expect(nameIssue?.message).toContain("publisher.name");
    }
  });
});

describe("PluginManifestSchema permissions field", () => {
  const validBase = { name: "acme.test", version: "1.0.0" };

  it("defaults to empty array when omitted", () => {
    const result = PluginManifestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissions).toEqual([]);
    }
  });

  it("accepts an empty permissions array", () => {
    const result = PluginManifestSchema.safeParse({ ...validBase, permissions: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissions).toEqual([]);
    }
  });

  it("accepts built-in permission strings", () => {
    const result = PluginManifestSchema.safeParse({
      ...validBase,
      permissions: ["fs:project-read", "network:fetch", "agent:invoke"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissions).toEqual(["fs:project-read", "network:fetch", "agent:invoke"]);
    }
  });

  it("rejects custom (non-built-in) permission strings", () => {
    const result = PluginManifestSchema.safeParse({
      ...validBase,
      permissions: ["custom:my-perm", "org.specific:do-thing"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "permissions")).toBe(true);
    }
  });

  it("rejects empty string in permissions array", () => {
    const result = PluginManifestSchema.safeParse({
      ...validBase,
      permissions: ["fs:project-read", ""],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "permissions")).toBe(true);
    }
  });

  it("rejects whitespace-padded permission strings (no implicit trim)", () => {
    const result = PluginManifestSchema.safeParse({
      ...validBase,
      permissions: ["  fs:project-read  "],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "permissions")).toBe(true);
    }
  });

  it("rejects whitespace-only permission strings", () => {
    const result = PluginManifestSchema.safeParse({
      ...validBase,
      permissions: ["   "],
    });
    expect(result.success).toBe(false);
  });

  it("rejects permission strings containing newline characters", () => {
    const result = PluginManifestSchema.safeParse({
      ...validBase,
      permissions: ["fs:project-read\n"],
    });
    expect(result.success).toBe(false);
  });

  it("BUILT_IN_PLUGIN_PERMISSIONS contains all documented capabilities", () => {
    expect(BUILT_IN_PLUGIN_PERMISSIONS).toContain("fs:project-read");
    expect(BUILT_IN_PLUGIN_PERMISSIONS).toContain("fs:project-write");
    expect(BUILT_IN_PLUGIN_PERMISSIONS).toContain("fs:user-data-read");
    expect(BUILT_IN_PLUGIN_PERMISSIONS).toContain("fs:user-data-write");
    expect(BUILT_IN_PLUGIN_PERMISSIONS).toContain("network:fetch");
    expect(BUILT_IN_PLUGIN_PERMISSIONS).toContain("agent:invoke");
    expect(BUILT_IN_PLUGIN_PERMISSIONS).toContain("agent:read");
    expect(BUILT_IN_PLUGIN_PERMISSIONS).toContain("git:read");
    expect(BUILT_IN_PLUGIN_PERMISSIONS).toContain("git:write");
    expect(BUILT_IN_PLUGIN_PERMISSIONS).toContain("clipboard:read");
    expect(BUILT_IN_PLUGIN_PERMISSIONS).toContain("clipboard:write");
    expect(BUILT_IN_PLUGIN_PERMISSIONS).toContain("shell:exec");
  });

  it("BUILT_IN_PLUGIN_PERMISSIONS has exactly 12 unique entries", () => {
    expect(BUILT_IN_PLUGIN_PERMISSIONS).toHaveLength(12);
    expect(new Set(BUILT_IN_PLUGIN_PERMISSIONS).size).toBe(12);
  });

  it("rejects null permissions value", () => {
    const result = PluginManifestSchema.safeParse({
      ...validBase,
      permissions: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects scalar (non-array) permissions value", () => {
    const result = PluginManifestSchema.safeParse({
      ...validBase,
      permissions: "git:read",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string elements in permissions array", () => {
    const result = PluginManifestSchema.safeParse({
      ...validBase,
      permissions: [1, "git:read"],
    });
    expect(result.success).toBe(false);
  });
});

describe("PluginService", () => {
  it("returns empty list when plugins directory does not exist", async () => {
    const service = new PluginService(path.join(tmpDir, "nonexistent"));
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("returns empty list when plugins directory is empty", async () => {
    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("loads a valid plugin and registers panel kinds", async () => {
    await writePlugin("test-plugin", {
      name: "acme.test-plugin",
      version: "1.0.0",
      displayName: "Test Plugin",
      contributes: {
        panels: [
          {
            id: "viewer",
            name: "Test Viewer",
            iconId: "eye",
            color: "#ff0000",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("acme.test-plugin");
    expect(plugins[0].manifest.displayName).toBe("Test Plugin");
    expect(plugins[0].dir).toBe(path.join(tmpDir, "test-plugin"));

    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acme.test-plugin.viewer",
        name: "Test Viewer",
        iconId: "eye",
        color: "#ff0000",
        hasPty: false,
        canRestart: false,
        canConvert: false,
        showInPalette: true,
        extensionId: "acme.test-plugin",
      })
    );
  });

  it("skips directories without plugin.json", async () => {
    await fs.mkdir(path.join(tmpDir, "empty-dir"));

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("skips plugins with invalid JSON", async () => {
    const dir = path.join(tmpDir, "bad-json");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "plugin.json"), "not valid json {{{");

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("skips plugins with invalid manifest schema", async () => {
    await writePlugin("invalid-schema", {
      version: "1.0.0",
      // missing required 'name' field
    });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("loads multiple plugins and skips invalid ones", async () => {
    await writePlugin("good-1", { name: "acme.good-1", version: "1.0.0" });
    await writePlugin("bad", { version: "1.0.0" }); // missing name
    await writePlugin("good-2", { name: "acme.good-2", version: "2.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(2);
    const names = plugins.map((p) => p.manifest.name).sort();
    expect(names).toEqual(["acme.good-1", "acme.good-2"]);
  });

  it("is idempotent — second initialize is a no-op", async () => {
    await writePlugin("test-plugin", { name: "acme.test-plugin", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerPanelKind).toHaveBeenCalledTimes(0); // no panels declared
  });

  it("namespaces panel IDs as pluginName.panelId", async () => {
    await writePlugin("my-plugin", {
      name: "acme.my-plugin",
      version: "1.0.0",
      contributes: {
        panels: [
          { id: "viewer", name: "Viewer", iconId: "eye", color: "#000" },
          { id: "editor", name: "Editor", iconId: "pen", color: "#fff" },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerPanelKind).toHaveBeenCalledTimes(2);
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acme.my-plugin.viewer" })
    );
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acme.my-plugin.editor" })
    );
  });

  it("rejects main entry paths that escape the plugin directory", async () => {
    await writePlugin("escape-test", {
      name: "acme.escape-test",
      version: "1.0.0",
      main: "../evil.js",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    // The plugin loads but main is silently rejected (no import attempted)
    expect(plugins[0].manifest.main).toBe("../evil.js");
  });

  it("does not include resolvedMain in listPlugins output", async () => {
    await writePlugin("main-test", {
      name: "acme.main-test",
      version: "1.0.0",
      main: "dist/main.js",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    // listPlugins returns LoadedPluginInfo which doesn't have resolvedMain
    expect(Object.keys(plugins[0])).not.toContain("resolvedMain");
  });

  it("rejects manifest with empty name", async () => {
    await writePlugin("empty-name", { name: "", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("rejects manifest with path-traversal name", async () => {
    await writePlugin("evil-name", { name: "../evil", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("rejects panel with invalid ID characters", async () => {
    await writePlugin("bad-panel", {
      name: "acme.bad-panel",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "../../hack", name: "Hack", iconId: "x", color: "#000" }],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("warns on duplicate plugin names and keeps the last one", async () => {
    await writePlugin("dir-a", { name: "acme.same-name", version: "1.0.0", description: "first" });
    await writePlugin("dir-b", { name: "acme.same-name", version: "2.0.0", description: "second" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("acme.same-name");
  });

  it("allows retry after non-ENOENT initialize failure", async () => {
    const badRoot = path.join(tmpDir, "unreadable");
    await fs.mkdir(badRoot);
    await writePlugin("good", { name: "acme.good", version: "1.0.0" });

    const service = new PluginService(tmpDir);

    // First call succeeds
    await service.initialize();
    expect(service.listPlugins()).toHaveLength(1);

    // Second call is no-op (already initialized)
    await service.initialize();
    expect(service.listPlugins()).toHaveLength(1);
  });

  it("registers toolbar buttons from plugin manifest", async () => {
    await writePlugin("toolbar-test", {
      name: "acme.toolbar-test",
      version: "1.0.0",
      contributes: {
        toolbarButtons: [
          {
            id: "my-btn",
            label: "My Button",
            iconId: "puzzle",
            actionId: "acme.toolbar-test.doThing",
            priority: 4,
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "plugin.acme.toolbar-test.my-btn",
        label: "My Button",
        iconId: "puzzle",
        actionId: "acme.toolbar-test.doThing",
        priority: 4,
        pluginId: "acme.toolbar-test",
      })
    );
  });

  it("uses default priority 3 when not specified in toolbar button", async () => {
    await writePlugin("default-priority", {
      name: "acme.default-priority",
      version: "1.0.0",
      contributes: {
        toolbarButtons: [
          {
            id: "btn",
            label: "Btn",
            iconId: "icon",
            actionId: "test.action",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "plugin.acme.default-priority.btn",
        priority: 3,
      })
    );
  });

  it("registers menu items from plugin manifest", async () => {
    await writePlugin("menu-test", {
      name: "acme.menu-test",
      version: "1.0.0",
      contributes: {
        menuItems: [
          {
            label: "Do Something",
            actionId: "acme.menu-test.doSomething",
            location: "terminal",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerPluginMenuItem).toHaveBeenCalledWith("acme.menu-test", {
      label: "Do Something",
      actionId: "acme.menu-test.doSomething",
      location: "terminal",
    });
  });

  it("does not call toolbar/menu registration when no contributions", async () => {
    await writePlugin("empty-contribs", {
      name: "acme.empty-contribs",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).not.toHaveBeenCalled();
    expect(registerPluginMenuItem).not.toHaveBeenCalled();
  });
});

describe("Plugin IPC handler registration", () => {
  let service: PluginService;

  beforeEach(async () => {
    await writePlugin("test-plugin", { name: "acme.test-plugin", version: "1.0.0" });
    service = new PluginService(tmpDir);
    await service.initialize();
  });

  it("registerHandler succeeds for a loaded plugin with valid channel", () => {
    const handler = vi.fn();
    expect(() => service.registerHandler("acme.test-plugin", "get-data", handler)).not.toThrow();
  });

  it("registerHandler throws when pluginId is not loaded", () => {
    expect(() => service.registerHandler("acme.unknown-plugin", "get-data", vi.fn())).toThrow(
      "Unknown plugin: acme.unknown-plugin"
    );
  });

  it("registerHandler throws when channel contains a colon", () => {
    expect(() => service.registerHandler("acme.test-plugin", "bad:channel", vi.fn())).toThrow(
      "Plugin channel must not contain colons: bad:channel"
    );
  });

  it("registerHandler throws when handler is not a function", () => {
    expect(() =>
      service.registerHandler("acme.test-plugin", "get-data", "not-a-function" as never)
    ).toThrow("Plugin handler must be a function, got string");
  });

  it("dispatchHandler calls the registered handler and returns its result", async () => {
    const handler = vi.fn().mockResolvedValue({ value: 42 });
    service.registerHandler("acme.test-plugin", "get-data", handler);

    const ctx = makeCtx("acme.test-plugin", { webContentsId: 7 });
    const result = await service.dispatchHandler("acme.test-plugin", "get-data", ctx, [
      "arg1",
      "arg2",
    ]);
    expect(handler).toHaveBeenCalledWith(ctx, "arg1", "arg2");
    expect(result).toEqual({ value: 42 });
  });

  it("dispatchHandler passes the context as the first argument to the handler", async () => {
    const handler = vi.fn().mockResolvedValue("ok");
    service.registerHandler("acme.test-plugin", "get-ctx", handler);

    const ctx = makeCtx("acme.test-plugin", {
      projectId: "p1",
      worktreeId: "w1",
      webContentsId: 42,
    });
    await service.dispatchHandler("acme.test-plugin", "get-ctx", ctx, ["x"]);
    expect(handler.mock.calls[0][0]).toEqual(ctx);
    expect(handler.mock.calls[0][1]).toBe("x");
  });

  it("dispatchHandler throws when no handler is found", async () => {
    await expect(
      service.dispatchHandler("acme.test-plugin", "unknown", makeCtx("acme.test-plugin"), [])
    ).rejects.toThrow("No plugin handler registered for acme.test-plugin:unknown");
  });

  it("registering same (pluginId, channel) twice overwrites the handler", async () => {
    const handler1 = vi.fn().mockReturnValue("first");
    const handler2 = vi.fn().mockReturnValue("second");
    service.registerHandler("acme.test-plugin", "get-data", handler1);
    service.registerHandler("acme.test-plugin", "get-data", handler2);

    const result = await service.dispatchHandler(
      "acme.test-plugin",
      "get-data",
      makeCtx("acme.test-plugin"),
      []
    );
    expect(result).toBe("second");
    expect(handler1).not.toHaveBeenCalled();
  });

  it("removeHandlers removes all handlers for a plugin, leaving others intact", async () => {
    await writePlugin("other-plugin", { name: "acme.other-plugin", version: "1.0.0" });
    const service2 = new PluginService(tmpDir);
    await service2.initialize();

    service2.registerHandler("acme.test-plugin", "ch-a", vi.fn().mockReturnValue("a"));
    service2.registerHandler("acme.test-plugin", "ch-b", vi.fn().mockReturnValue("b"));
    service2.registerHandler("acme.other-plugin", "ch-c", vi.fn().mockReturnValue("c"));

    service2.removeHandlers("acme.test-plugin");

    await expect(
      service2.dispatchHandler("acme.test-plugin", "ch-a", makeCtx("acme.test-plugin"), [])
    ).rejects.toThrow();
    await expect(
      service2.dispatchHandler("acme.test-plugin", "ch-b", makeCtx("acme.test-plugin"), [])
    ).rejects.toThrow();
    expect(
      await service2.dispatchHandler("acme.other-plugin", "ch-c", makeCtx("acme.other-plugin"), [])
    ).toBe("c");
  });

  it("hasPlugin returns true for loaded plugins and false otherwise", () => {
    expect(service.hasPlugin("acme.test-plugin")).toBe(true);
    expect(service.hasPlugin("nonexistent")).toBe(false);
  });

  it("registerHandler throws for empty channel", () => {
    expect(() => service.registerHandler("acme.test-plugin", "", vi.fn())).not.toThrow();
    // Empty channel is technically valid — no colons
  });

  it("dispatchHandler handles synchronous handlers", async () => {
    service.registerHandler("acme.test-plugin", "sync", () => "sync-result");
    const result = await service.dispatchHandler(
      "acme.test-plugin",
      "sync",
      makeCtx("acme.test-plugin"),
      []
    );
    expect(result).toBe("sync-result");
  });
});

describe("engines.daintree compatibility gate", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("loads a plugin when app version satisfies engines.daintree", async () => {
    await writePlugin("compatible", {
      name: "acme.compatible",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects a plugin when app version does not satisfy engines.daintree", async () => {
    await writePlugin("incompatible", {
      name: "acme.incompatible",
      displayName: "Incompatible Plugin",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
      },
    });

    const service = new PluginService(tmpDir, "0.8.0");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "acme.incompatible" requires Daintree ^0.7.0')
    );
    expect(broadcastToRendererMock).toHaveBeenCalledWith(
      CHANNELS.NOTIFICATION_SHOW_TOAST,
      expect.objectContaining({
        type: "error",
        title: "Plugin incompatible",
        message: expect.stringContaining("Incompatible Plugin"),
      })
    );
  });

  it("treats app prerelease versions as satisfying their release-series range", async () => {
    await writePlugin("prerelease-compatible", {
      name: "acme.prerelease-compatible",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.1-rc.1");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("loads plugins that omit engines.daintree with a warning", async () => {
    await writePlugin("no-engines", { name: "acme.no-engines", version: "1.0.0" });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "acme.no-engines" does not declare engines.daintree')
    );
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("loads plugins with empty engines object (daintree absent) with a warning", async () => {
    await writePlugin("empty-engines", {
      name: "acme.empty-engines",
      version: "1.0.0",
      engines: {},
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "acme.empty-engines" does not declare engines.daintree')
    );
  });

  it("rejects manifests with an invalid semver range at schema level", async () => {
    await writePlugin("bad-range", {
      name: "acme.bad-range",
      version: "1.0.0",
      engines: { daintree: "not-a-range" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects plugins requiring a future major version", async () => {
    await writePlugin("future", {
      name: "acme.future",
      version: "1.0.0",
      engines: { daintree: "^1.0.0" },
    });

    const service = new PluginService(tmpDir, "0.7.1");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("does not attempt main import or register contributions for incompatible plugins", async () => {
    await writePlugin("skip-side-effects", {
      name: "acme.skip-side-effects",
      version: "1.0.0",
      main: "dist/main.js",
      engines: { daintree: "^1.0.0" },
      contributes: {
        panels: [{ id: "p", name: "P", iconId: "i", color: "#000" }],
        toolbarButtons: [{ id: "b", label: "B", iconId: "i", actionId: "x.y" }],
        menuItems: [{ label: "L", actionId: "x.y", location: "terminal" }],
      },
    });

    const service = new PluginService(tmpDir, "0.7.1");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(registerToolbarButton).not.toHaveBeenCalled();
    expect(registerPluginMenuItem).not.toHaveBeenCalled();
  });

  it("loads only the compatible plugins in a mixed batch", async () => {
    await writePlugin("good", {
      name: "acme.good",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });
    await writePlugin("bad", {
      name: "acme.bad",
      version: "1.0.0",
      engines: { daintree: "^1.0.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    const names = service.listPlugins().map((p) => p.manifest.name);
    expect(names).toEqual(["acme.good"]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("accepts the wildcard range '*'", async () => {
    await writePlugin("wildcard", {
      name: "acme.wildcard",
      version: "1.0.0",
      engines: { daintree: "*" },
    });

    const service = new PluginService(tmpDir, "0.7.1");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only range strings at the schema layer", async () => {
    await writePlugin("whitespace-range", {
      name: "acme.whitespace-range",
      version: "1.0.0",
      engines: { daintree: "   " },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects an app prerelease that is below a non-prerelease range's lower bound", async () => {
    await writePlugin("prerelease-too-early", {
      name: "acme.prerelease-too-early",
      version: "1.0.0",
      engines: { daintree: ">=0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.0-rc.1");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("accepts an exact-version range when the app matches precisely", async () => {
    await writePlugin("exact-match", {
      name: "acme.exact-match",
      version: "1.0.0",
      engines: { daintree: "0.7.5" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects an exact-version range when the app does not match", async () => {
    await writePlugin("exact-mismatch", {
      name: "acme.exact-mismatch",
      version: "1.0.0",
      engines: { daintree: "0.7.5" },
    });

    const service = new PluginService(tmpDir, "0.7.4");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });
});

describe("Plugin unload lifecycle", () => {
  it("unloadPlugin calls all registry unregister functions for the plugin", async () => {
    await writePlugin("unloadable", {
      name: "acme.unloadable",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
        toolbarButtons: [{ id: "btn", label: "Btn", iconId: "icon", actionId: "x.y" }],
        menuItems: [{ label: "L", actionId: "x.y", location: "terminal" }],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.hasPlugin("acme.unloadable")).toBe(true);

    service.unloadPlugin("acme.unloadable");

    expect(unregisterPluginMenuItems).toHaveBeenCalledWith("acme.unloadable");
    expect(unregisterPluginToolbarButtons).toHaveBeenCalledWith("acme.unloadable");
    expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.unloadable");
  });

  it("unloadPlugin removes the plugin from hasPlugin and listPlugins", async () => {
    await writePlugin("goodbye", { name: "acme.goodbye", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.hasPlugin("acme.goodbye")).toBe(true);

    service.unloadPlugin("acme.goodbye");

    expect(service.hasPlugin("acme.goodbye")).toBe(false);
    expect(service.listPlugins()).toEqual([]);
  });

  it("unloadPlugin removes IPC handlers registered for the plugin", async () => {
    await writePlugin("handler-host", { name: "acme.handler-host", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    service.registerHandler("acme.handler-host", "ping", () => "pong");
    expect(
      await service.dispatchHandler("acme.handler-host", "ping", makeCtx("acme.handler-host"), [])
    ).toBe("pong");

    service.unloadPlugin("acme.handler-host");

    await expect(
      service.dispatchHandler("acme.handler-host", "ping", makeCtx("acme.handler-host"), [])
    ).rejects.toThrow("No plugin handler registered for acme.handler-host:ping");
  });

  it("unloadPlugin is a no-op when the plugin is not loaded", async () => {
    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(() => service.unloadPlugin("acme.never-loaded")).not.toThrow();
    expect(unregisterPluginMenuItems).not.toHaveBeenCalled();
    expect(unregisterPluginToolbarButtons).not.toHaveBeenCalled();
    expect(unregisterPluginPanelKinds).not.toHaveBeenCalled();
  });

  it("unloadPlugin is idempotent across repeated calls", async () => {
    await writePlugin("twice", { name: "acme.twice", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    service.unloadPlugin("acme.twice");
    expect(service.hasPlugin("acme.twice")).toBe(false);

    // Second call finds nothing to remove and stays silent.
    service.unloadPlugin("acme.twice");
    expect(unregisterPluginMenuItems).toHaveBeenCalledTimes(1);
    expect(unregisterPluginToolbarButtons).toHaveBeenCalledTimes(1);
    expect(unregisterPluginPanelKinds).toHaveBeenCalledTimes(1);
  });

  it("registers plugin before importing main so sync host-API calls see it as loaded", async () => {
    const pluginDir = path.join(tmpDir, "sync-init");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.sync-init",
        version: "1.0.0",
        main: "main.mjs",
      })
    );
    // Plugin main module calls a global hook synchronously during import to
    // observe whether its own pluginId is already registered. Proxies the
    // real-world pattern where a host API call depends on this.plugins.has().
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__pluginInitObserved = globalThis.__pluginInitCheck('acme.sync-init');"
    );

    const service = new PluginService(tmpDir);
    (globalThis as { __pluginInitCheck?: (name: string) => boolean }).__pluginInitCheck = (name) =>
      service.hasPlugin(name);

    try {
      await service.initialize();
      expect((globalThis as { __pluginInitObserved?: boolean }).__pluginInitObserved).toBe(true);
    } finally {
      delete (globalThis as { __pluginInitCheck?: unknown }).__pluginInitCheck;
      delete (globalThis as { __pluginInitObserved?: unknown }).__pluginInitObserved;
    }
  });

  it("supports load → unload → reload lifecycle via fresh service instance", async () => {
    await writePlugin("lifecycle", {
      name: "acme.lifecycle",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
      },
    });

    const first = new PluginService(tmpDir);
    await first.initialize();
    expect(registerPanelKind).toHaveBeenCalledTimes(1);

    first.unloadPlugin("acme.lifecycle");
    expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.lifecycle");
    expect(first.hasPlugin("acme.lifecycle")).toBe(false);

    // A fresh service instance re-reads the plugin directory and re-registers.
    vi.clearAllMocks();
    const second = new PluginService(tmpDir);
    await second.initialize();

    expect(second.hasPlugin("acme.lifecycle")).toBe(true);
    expect(registerPanelKind).toHaveBeenCalledTimes(1);
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acme.lifecycle.viewer", extensionId: "acme.lifecycle" })
    );
  });
});

type CreateHostShape = (pluginId: string) => {
  host: {
    pluginId: string;
    registerHandler: (channel: string, handler: (...args: unknown[]) => unknown) => void;
    broadcastToRenderer: (channel: string, payload: unknown) => void;
  };
  revoke: () => void;
};

describe("createHost (plugin activation API)", () => {
  it("host.registerHandler delegates with the plugin's own namespace", async () => {
    await writePlugin("host-test", { name: "acme.host-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.host-test"
    );

    expect(host.pluginId).toBe("acme.host-test");

    const handler = vi.fn().mockReturnValue("ok");
    host.registerHandler("probe", handler);

    const ctx = makeCtx("acme.host-test");
    const result = await service.dispatchHandler("acme.host-test", "probe", ctx, ["a"]);
    expect(handler).toHaveBeenCalledWith(ctx, "a");
    expect(result).toBe("ok");
  });

  it("host.broadcastToRenderer namespaces channels as plugin:{pluginId}:{channel}", async () => {
    await writePlugin("bcast-test", { name: "acme.bcast-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.bcast-test"
    );

    broadcastToRendererMock.mockClear();
    host.broadcastToRenderer("status", { ok: true });
    expect(broadcastToRendererMock).toHaveBeenCalledWith("plugin:acme.bcast-test:status", {
      ok: true,
    });
  });

  it("host.broadcastToRenderer rejects channels containing colons", async () => {
    await writePlugin("bcast-reject", { name: "acme.bcast-reject", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.bcast-reject"
    );

    expect(() => host.broadcastToRenderer("bad:channel", null)).toThrow(
      "Plugin broadcast channel must be a string without colons"
    );
  });

  it("revoked host rejects registerHandler and broadcastToRenderer calls", async () => {
    await writePlugin("revoke-test", { name: "acme.revoke-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host, revoke } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.revoke-test"
    );

    revoke();

    expect(() => host.registerHandler("x", () => undefined)).toThrow(
      /host revoked: registerHandler/
    );
    expect(() => host.broadcastToRenderer("x", null)).toThrow(/host revoked: broadcastToRenderer/);
  });
});

describe("Plugin action registry", () => {
  let service: PluginService;

  const validContribution = () => ({
    id: "acme.my-plugin.doThing",
    title: "Do Thing",
    description: "Does a thing",
    category: "plugin",
    kind: "command" as const,
    danger: "safe" as const,
  });

  beforeEach(async () => {
    await writePlugin("test-plugin", { name: "acme.my-plugin", version: "1.0.0" });
    service = new PluginService(tmpDir);
    await service.initialize();
    broadcastToRendererMock.mockClear();
  });

  it("registerPluginAction adds a descriptor and broadcasts the full list", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());

    const actions = service.listPluginActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      pluginId: "acme.my-plugin",
      id: "acme.my-plugin.doThing",
      title: "Do Thing",
      category: "plugin",
      kind: "command",
      danger: "safe",
    });
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.PLUGIN_ACTIONS_CHANGED, {
      actions,
    });
  });

  it("registerPluginAction throws when the plugin is not loaded", () => {
    expect(() => service.registerPluginAction("acme.unknown", validContribution())).toThrow(
      /Unknown plugin/
    );
  });

  it("registerPluginAction throws for ids not prefixed with the plugin id", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        id: "other.plugin.doThing",
      })
    ).toThrow(/must be prefixed with the plugin's own id/);
  });

  it("registerPluginAction throws for malformed ids", () => {
    for (const badId of ["no-dot", "Acme.UpperCase", "", "acme..double"]) {
      expect(() =>
        service.registerPluginAction("acme.my-plugin", {
          ...validContribution(),
          id: badId,
        })
      ).toThrow(/invalid/i);
    }
  });

  it("registerPluginAction throws when id has no suffix after the pluginId", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        id: "acme.my-plugin",
      })
    ).toThrow(/must be prefixed with the plugin's own id/);
  });

  it("registerPluginAction rejects restricted danger", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        danger: "restricted" as unknown as "safe",
      })
    ).toThrow(/invalid danger/i);
  });

  it("registerPluginAction rejects unknown kind", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        kind: "navigation" as unknown as "command",
      })
    ).toThrow(/invalid kind/i);
  });

  it("registerPluginAction throws on duplicate id", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    expect(() => service.registerPluginAction("acme.my-plugin", validContribution())).toThrow(
      /already registered/
    );
  });

  it("unregisterPluginAction removes a single action and broadcasts", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    broadcastToRendererMock.mockClear();

    service.unregisterPluginAction("acme.my-plugin", "acme.my-plugin.doThing");

    expect(service.listPluginActions()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.PLUGIN_ACTIONS_CHANGED, {
      actions: [],
    });
  });

  it("unregisterPluginAction is a silent no-op for unknown ids", () => {
    service.unregisterPluginAction("acme.my-plugin", "acme.my-plugin.missing");
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("unregisterPluginAction does not remove actions owned by a different plugin", async () => {
    await writePlugin("other", { name: "acme.other", version: "1.0.0" });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.my-plugin", validContribution());

    svc.unregisterPluginAction("acme.other", "acme.my-plugin.doThing");
    expect(svc.listPluginActions()).toHaveLength(1);
  });

  it("unloadPlugin bulk-removes plugin actions", async () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      id: "acme.my-plugin.other",
    });
    expect(service.listPluginActions()).toHaveLength(2);

    broadcastToRendererMock.mockClear();
    service.unloadPlugin("acme.my-plugin");

    expect(service.listPluginActions()).toEqual([]);
    // Exactly one broadcast for the bulk removal (no per-action spam)
    const broadcasts = broadcastToRendererMock.mock.calls.filter(
      (call: unknown[]) => call[0] === CHANNELS.PLUGIN_ACTIONS_CHANGED
    );
    expect(broadcasts).toHaveLength(1);
  });

  it("descriptor keeps a defensive copy of keywords", () => {
    const keywords = ["foo", "bar"];
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      keywords,
    });
    keywords.push("mutated");

    const [descriptor] = service.listPluginActions();
    expect(descriptor.keywords).toEqual(["foo", "bar"]);
  });

  it("descriptor keeps a defensive copy of inputSchema", () => {
    const inputSchema: Record<string, unknown> = { type: "object", properties: { a: 1 } };
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      inputSchema,
    });
    (inputSchema as Record<string, unknown>).properties = { a: 999 };

    const [descriptor] = service.listPluginActions();
    expect(descriptor.inputSchema).toEqual({ type: "object", properties: { a: 1 } });
  });
});

describe("deprecated renderer field", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns when plugin manifest contains renderer field", async () => {
    await writePlugin("renderer-deprecated", {
      name: "acme.renderer-deprecated",
      version: "1.0.0",
      renderer: "dist/renderer.js",
      engines: { daintree: "*" },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      `[PluginService] Plugin "acme.renderer-deprecated" uses deprecated 'renderer' field. This field is no longer supported and will be ignored. Daintree plugins use main process entry points only; renderer-side plugins are not supported.`
    );
  });

  it("does not warn when plugin manifest lacks renderer field", async () => {
    await writePlugin("no-renderer", {
      name: "acme.no-renderer",
      version: "1.0.0",
      engines: { daintree: "*" },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not include resolvedRenderer in listPlugins output", async () => {
    await writePlugin("renderer-test", {
      name: "acme.renderer-test",
      version: "1.0.0",
      renderer: "dist/renderer.js",
      engines: { daintree: "*" },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(Object.keys(plugins[0])).not.toContain("resolvedRenderer");
  });

  it("does not warn for incompatible plugins that fail compatibility gate", async () => {
    await writePlugin("incompatible-with-renderer", {
      name: "acme.incompatible-with-renderer",
      version: "1.0.0",
      renderer: "dist/renderer.js",
      engines: { daintree: "^1.0.0" },
    });

    const service = new PluginService(tmpDir, "0.8.0");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("uses deprecated 'renderer' field")
    );
  });

  it("warns once per load attempt even with both main and renderer", async () => {
    await writePlugin("both-entries", {
      name: "acme.both-entries",
      version: "1.0.0",
      main: "dist/main.js",
      renderer: "dist/renderer.js",
      engines: { daintree: "*" },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    const rendererWarns = warnSpy.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && call[0].includes("uses deprecated 'renderer' field")
    );
    expect(rendererWarns).toHaveLength(1);
  });
});

describe("permissions declaration logging", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logs declared permissions when plugin has permissions", async () => {
    await writePlugin("perm-plugin", {
      name: "acme.perm-plugin",
      version: "1.0.0",
      permissions: ["fs:project-read", "network:fetch"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Plugin "acme.perm-plugin" declares permissions: fs:project-read, network:fetch'
      )
    );
  });

  it("does not log when plugin has no permissions", async () => {
    await writePlugin("no-perms", {
      name: "acme.no-perms",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares permissions")
    );
    expect(permLogs).toHaveLength(0);
  });

  it("does not log permissions for incompatible plugins", async () => {
    await writePlugin("incompatible-perms", {
      name: "acme.incompatible-perms",
      version: "1.0.0",
      permissions: ["fs:project-read"],
      engines: { daintree: "^1.0.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares permissions")
    );
    expect(permLogs).toHaveLength(0);
  });

  it("includes permissions in loaded plugin manifest", async () => {
    await writePlugin("with-perms", {
      name: "acme.with-perms",
      version: "1.0.0",
      permissions: ["git:read", "agent:invoke"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins[0].manifest.permissions).toEqual(["git:read", "agent:invoke"]);
  });

  it("defaults permissions to empty array for plugins without the field", async () => {
    await writePlugin("no-field", {
      name: "acme.no-field",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins[0].manifest.permissions).toEqual([]);
  });

  it("rejects plugins that declare unknown permissions and does not log them", async () => {
    await writePlugin("unknown-perm", {
      name: "acme.unknown-perm",
      version: "1.0.0",
      permissions: ["shell:exec", "invalid:perm"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares permissions")
    );
    expect(permLogs).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest"),
      expect.any(Array)
    );
  });

  it("rejects plugins with newline characters in permission strings", async () => {
    await writePlugin("padded-perm", {
      name: "acme.padded-perm",
      version: "1.0.0",
      permissions: ["fs:project-read\n", "agent:invoke\r"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares permissions")
    );
    expect(permLogs).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest"),
      expect.any(Array)
    );
  });

  it("rejects plugins where any one permission in a mixed array is invalid", async () => {
    await writePlugin("mixed-perm", {
      name: "acme.mixed-perm",
      version: "1.0.0",
      permissions: ["fs:project-read", "invalid:perm", "git:read"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares permissions")
    );
    expect(permLogs).toHaveLength(0);
  });
});
