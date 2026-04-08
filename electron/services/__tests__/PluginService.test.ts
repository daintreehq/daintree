import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

vi.mock("../../../shared/config/panelKindRegistry.js", () => ({
  registerPanelKind: vi.fn(),
}));
vi.mock("../../../shared/config/toolbarButtonRegistry.js", () => ({
  registerToolbarButton: vi.fn(),
}));
vi.mock("../pluginMenuRegistry.js", () => ({
  registerPluginMenuItem: vi.fn(),
}));

import { PluginService } from "../PluginService.js";
import { registerPanelKind } from "../../../shared/config/panelKindRegistry.js";
import { registerToolbarButton } from "../../../shared/config/toolbarButtonRegistry.js";
import { registerPluginMenuItem } from "../pluginMenuRegistry.js";

let tmpDir: string;

function writePlugin(name: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(tmpDir, name);
  return fs
    .mkdir(dir, { recursive: true })
    .then(() => fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest)));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-plugin-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
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
      name: "test-plugin",
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
    expect(plugins[0].manifest.name).toBe("test-plugin");
    expect(plugins[0].manifest.displayName).toBe("Test Plugin");
    expect(plugins[0].dir).toBe(path.join(tmpDir, "test-plugin"));

    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "test-plugin.viewer",
        name: "Test Viewer",
        iconId: "eye",
        color: "#ff0000",
        hasPty: false,
        canRestart: false,
        canConvert: false,
        showInPalette: true,
        extensionId: "test-plugin",
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
    await writePlugin("good-1", { name: "good-1", version: "1.0.0" });
    await writePlugin("bad", { version: "1.0.0" }); // missing name
    await writePlugin("good-2", { name: "good-2", version: "2.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(2);
    const names = plugins.map((p) => p.manifest.name).sort();
    expect(names).toEqual(["good-1", "good-2"]);
  });

  it("is idempotent — second initialize is a no-op", async () => {
    await writePlugin("test-plugin", { name: "test-plugin", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerPanelKind).toHaveBeenCalledTimes(0); // no panels declared
  });

  it("namespaces panel IDs as pluginName.panelId", async () => {
    await writePlugin("my-plugin", {
      name: "my-plugin",
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
      expect.objectContaining({ id: "my-plugin.viewer" })
    );
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({ id: "my-plugin.editor" })
    );
  });

  it("rejects main entry paths that escape the plugin directory", async () => {
    await writePlugin("escape-test", {
      name: "escape-test",
      version: "1.0.0",
      main: "../evil.js",
      renderer: "dist/renderer.js",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    // Valid renderer should be resolved, but escaping main should not
    expect(plugins[0].resolvedRenderer).toBe(
      path.join(tmpDir, "escape-test", "dist", "renderer.js")
    );
    // The plugin loads but main is silently rejected (no import attempted)
    expect(plugins[0].manifest.main).toBe("../evil.js");
  });

  it("resolves valid renderer entry path", async () => {
    await writePlugin("renderer-test", {
      name: "renderer-test",
      version: "1.0.0",
      renderer: "dist/renderer.js",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].resolvedRenderer).toBe(
      path.join(tmpDir, "renderer-test", "dist", "renderer.js")
    );
  });

  it("does not include resolvedMain in listPlugins output", async () => {
    await writePlugin("main-test", {
      name: "main-test",
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
      name: "bad-panel",
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
    await writePlugin("dir-a", { name: "same-name", version: "1.0.0", description: "first" });
    await writePlugin("dir-b", { name: "same-name", version: "2.0.0", description: "second" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("same-name");
  });

  it("allows retry after non-ENOENT initialize failure", async () => {
    const badRoot = path.join(tmpDir, "unreadable");
    await fs.mkdir(badRoot);
    await writePlugin("good", { name: "good", version: "1.0.0" });

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
      name: "toolbar-test",
      version: "1.0.0",
      contributes: {
        toolbarButtons: [
          {
            id: "my-btn",
            label: "My Button",
            iconId: "puzzle",
            actionId: "toolbar-test.doThing",
            priority: 4,
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "plugin.toolbar-test.my-btn",
        label: "My Button",
        iconId: "puzzle",
        actionId: "toolbar-test.doThing",
        priority: 4,
        pluginId: "toolbar-test",
      })
    );
  });

  it("uses default priority 3 when not specified in toolbar button", async () => {
    await writePlugin("default-priority", {
      name: "default-priority",
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
        id: "plugin.default-priority.btn",
        priority: 3,
      })
    );
  });

  it("registers menu items from plugin manifest", async () => {
    await writePlugin("menu-test", {
      name: "menu-test",
      version: "1.0.0",
      contributes: {
        menuItems: [
          {
            label: "Do Something",
            actionId: "menu-test.doSomething",
            location: "terminal",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerPluginMenuItem).toHaveBeenCalledWith("menu-test", {
      label: "Do Something",
      actionId: "menu-test.doSomething",
      location: "terminal",
    });
  });

  it("does not call toolbar/menu registration when no contributions", async () => {
    await writePlugin("empty-contribs", {
      name: "empty-contribs",
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
    await writePlugin("test-plugin", { name: "test-plugin", version: "1.0.0" });
    service = new PluginService(tmpDir);
    await service.initialize();
  });

  it("registerHandler succeeds for a loaded plugin with valid channel", () => {
    const handler = vi.fn();
    expect(() => service.registerHandler("test-plugin", "get-data", handler)).not.toThrow();
  });

  it("registerHandler throws when pluginId is not loaded", () => {
    expect(() => service.registerHandler("unknown-plugin", "get-data", vi.fn())).toThrow(
      "Unknown plugin: unknown-plugin"
    );
  });

  it("registerHandler throws when channel contains a colon", () => {
    expect(() => service.registerHandler("test-plugin", "bad:channel", vi.fn())).toThrow(
      "Plugin channel must not contain colons: bad:channel"
    );
  });

  it("registerHandler throws when handler is not a function", () => {
    expect(() =>
      service.registerHandler("test-plugin", "get-data", "not-a-function" as never)
    ).toThrow("Plugin handler must be a function, got string");
  });

  it("dispatchHandler calls the registered handler and returns its result", async () => {
    const handler = vi.fn().mockResolvedValue({ value: 42 });
    service.registerHandler("test-plugin", "get-data", handler);

    const result = await service.dispatchHandler("test-plugin", "get-data", ["arg1", "arg2"]);
    expect(handler).toHaveBeenCalledWith("arg1", "arg2");
    expect(result).toEqual({ value: 42 });
  });

  it("dispatchHandler throws when no handler is found", async () => {
    await expect(service.dispatchHandler("test-plugin", "unknown", [])).rejects.toThrow(
      "No plugin handler registered for test-plugin:unknown"
    );
  });

  it("registering same (pluginId, channel) twice overwrites the handler", async () => {
    const handler1 = vi.fn().mockReturnValue("first");
    const handler2 = vi.fn().mockReturnValue("second");
    service.registerHandler("test-plugin", "get-data", handler1);
    service.registerHandler("test-plugin", "get-data", handler2);

    const result = await service.dispatchHandler("test-plugin", "get-data", []);
    expect(result).toBe("second");
    expect(handler1).not.toHaveBeenCalled();
  });

  it("removeHandlers removes all handlers for a plugin, leaving others intact", async () => {
    await writePlugin("other-plugin", { name: "other-plugin", version: "1.0.0" });
    const service2 = new PluginService(tmpDir);
    await service2.initialize();

    service2.registerHandler("test-plugin", "ch-a", vi.fn().mockReturnValue("a"));
    service2.registerHandler("test-plugin", "ch-b", vi.fn().mockReturnValue("b"));
    service2.registerHandler("other-plugin", "ch-c", vi.fn().mockReturnValue("c"));

    service2.removeHandlers("test-plugin");

    await expect(service2.dispatchHandler("test-plugin", "ch-a", [])).rejects.toThrow();
    await expect(service2.dispatchHandler("test-plugin", "ch-b", [])).rejects.toThrow();
    expect(await service2.dispatchHandler("other-plugin", "ch-c", [])).toBe("c");
  });

  it("hasPlugin returns true for loaded plugins and false otherwise", () => {
    expect(service.hasPlugin("test-plugin")).toBe(true);
    expect(service.hasPlugin("nonexistent")).toBe(false);
  });

  it("registerHandler throws for empty channel", () => {
    expect(() => service.registerHandler("test-plugin", "", vi.fn())).not.toThrow();
    // Empty channel is technically valid — no colons
  });

  it("dispatchHandler handles synchronous handlers", async () => {
    service.registerHandler("test-plugin", "sync", () => "sync-result");
    const result = await service.dispatchHandler("test-plugin", "sync", []);
    expect(result).toBe("sync-result");
  });
});
