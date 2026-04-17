import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";

/**
 * Integration test: plugin loading lifecycle end-to-end with the REAL
 * contribution registries.
 *
 * The unit test (`PluginService.test.ts`) mocks `panelKindRegistry`,
 * `toolbarButtonRegistry`, and `pluginMenuRegistry`, so it never verifies
 * that a plugin's contributions actually land in those registries. These
 * tests use the real registries and a real fixture plugin on disk to
 * cover that gap.
 *
 * Notes:
 * - `electron.app.getVersion` must be mocked because `PluginService.ts`
 *   exports a module-level `pluginService` singleton that is constructed at
 *   import time. Tests under test pass `appVersion` explicitly to their own
 *   `PluginService` instance, but the module evaluation path still touches
 *   `app.getVersion()` via the singleton.
 * - `broadcastToRenderer` is also mocked because it is imported at module
 *   scope by `PluginService` and called from the `engines.daintree` reject path.
 * - `vitest.integration.config.ts` uses `pool: forks` with `singleFork: true`,
 *   so the module-level registries persist across tests. `afterEach` clears
 *   them explicitly.
 * - Node's native ESM loader caches dynamic `import()` by URL string and
 *   `vi.resetModules()` does not affect that cache. Fixture `.mjs` files
 *   are written with `randomUUID()` in their filenames so every test
 *   produces a distinct URL and re-executes module-level side effects.
 */

vi.mock("electron", () => ({
  app: { getVersion: vi.fn(() => "0.0.0") },
}));
vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
}));

import { PluginService } from "../PluginService.js";
import {
  clearPanelKindRegistry,
  getPanelKindConfig,
} from "../../../shared/config/panelKindRegistry.js";
import {
  clearToolbarButtonRegistry,
  getToolbarButtonConfig,
} from "../../../shared/config/toolbarButtonRegistry.js";
import { clearPluginMenuRegistry, getPluginMenuItems } from "../pluginMenuRegistry.js";

type PluginManifestShape = {
  name: string;
  version: string;
  displayName?: string;
  main?: string;
  contributes?: {
    panels?: unknown[];
    toolbarButtons?: unknown[];
    menuItems?: unknown[];
  };
};

let tmpDir: string;
const globalMarkers = new Set<string>();

async function writePlugin(pluginDirName: string, manifest: PluginManifestShape): Promise<string> {
  const dir = path.join(tmpDir, pluginDirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  return dir;
}

async function writeMainFixture(pluginDir: string, markerKey: string): Promise<string> {
  const fileName = `main-${randomUUID()}.mjs`;
  const filePath = path.join(pluginDir, fileName);
  await fs.writeFile(
    filePath,
    `globalThis[${JSON.stringify(markerKey)}] = (globalThis[${JSON.stringify(markerKey)}] ?? 0) + 1;\n`
  );
  return fileName;
}

function makeMarkerKey(): string {
  const key = `__test_plugin_main_loaded_${randomUUID().replace(/-/g, "")}`;
  globalMarkers.add(key);
  return key;
}

function readMarker(key: string): unknown {
  return (globalThis as Record<string, unknown>)[key];
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-int-"));
});

afterEach(async () => {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } finally {
    clearPanelKindRegistry();
    clearToolbarButtonRegistry();
    clearPluginMenuRegistry();
    for (const key of globalMarkers) {
      delete (globalThis as Record<string, unknown>)[key];
    }
    globalMarkers.clear();
    vi.clearAllMocks();
  }
});

describe("PluginService integration — panel contributions", () => {
  it("registers a panel contribution in the real panelKindRegistry", async () => {
    await writePlugin("panel-plugin", {
      name: "panel-plugin",
      version: "1.0.0",
      contributes: {
        panels: [
          {
            id: "viewer",
            name: "Viewer",
            iconId: "eye",
            color: "#ff0000",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    const config = getPanelKindConfig("panel-plugin.viewer");
    expect(config).toBeDefined();
    expect(config).toMatchObject({
      id: "panel-plugin.viewer",
      name: "Viewer",
      iconId: "eye",
      color: "#ff0000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      showInPalette: true,
      extensionId: "panel-plugin",
    });
  });

  it("registers multiple panels from one plugin with full config per panel", async () => {
    await writePlugin("multi-panel", {
      name: "multi-panel",
      version: "1.0.0",
      contributes: {
        panels: [
          { id: "viewer", name: "Viewer", iconId: "eye", color: "#111" },
          { id: "editor", name: "Editor", iconId: "pen", color: "#222" },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    expect(getPanelKindConfig("multi-panel.viewer")).toMatchObject({
      id: "multi-panel.viewer",
      name: "Viewer",
      iconId: "eye",
      color: "#111",
      extensionId: "multi-panel",
    });
    expect(getPanelKindConfig("multi-panel.editor")).toMatchObject({
      id: "multi-panel.editor",
      name: "Editor",
      iconId: "pen",
      color: "#222",
      extensionId: "multi-panel",
    });
  });

  it("propagates non-default panel flags through to the registry", async () => {
    await writePlugin("flag-plugin", {
      name: "flag-plugin",
      version: "1.0.0",
      contributes: {
        panels: [
          {
            id: "custom",
            name: "Custom",
            iconId: "box",
            color: "#0f0",
            hasPty: true,
            canRestart: true,
            canConvert: true,
            showInPalette: false,
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    expect(getPanelKindConfig("flag-plugin.custom")).toMatchObject({
      hasPty: true,
      canRestart: true,
      canConvert: true,
      showInPalette: false,
    });
  });

  it("preserves built-in panel kind configs intact after loading an extension", async () => {
    await writePlugin("built-in-coexist", {
      name: "built-in-coexist",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "p", name: "P", iconId: "i", color: "#000" }],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    expect(getPanelKindConfig("terminal")).toMatchObject({
      id: "terminal",
      hasPty: true,
      canRestart: true,
      showInPalette: false,
    });
    expect(getPanelKindConfig("agent")).toMatchObject({
      id: "agent",
      hasPty: true,
      showInPalette: false,
    });
    expect(getPanelKindConfig("browser")).toMatchObject({
      id: "browser",
      iconId: "globe",
      hasPty: false,
      showInPalette: true,
    });
    expect(getPanelKindConfig("notes")).toMatchObject({ id: "notes", iconId: "sticky-note" });
    expect(getPanelKindConfig("dev-preview")).toMatchObject({
      id: "dev-preview",
      iconId: "monitor",
    });
  });

  it("uses manifest.name not directory name when registering contributions", async () => {
    await writePlugin("alias-dir", {
      name: "real-plugin",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#abc" }],
        toolbarButtons: [
          { id: "btn", label: "B", iconId: "i", actionId: "real-plugin.act", priority: 2 },
        ],
        menuItems: [{ label: "M", actionId: "real-plugin.act", location: "view" }],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    expect(getPanelKindConfig("real-plugin.viewer")?.extensionId).toBe("real-plugin");
    expect(getPanelKindConfig("alias-dir.viewer")).toBeUndefined();

    expect(getToolbarButtonConfig("plugin.real-plugin.btn")?.pluginId).toBe("real-plugin");
    expect(getToolbarButtonConfig("plugin.alias-dir.btn")).toBeUndefined();

    const items = getPluginMenuItems();
    expect(items).toHaveLength(1);
    expect(items[0].pluginId).toBe("real-plugin");
  });
});

describe("PluginService integration — toolbar button contributions", () => {
  it("registers a toolbar button in the real toolbarButtonRegistry", async () => {
    await writePlugin("toolbar-plugin", {
      name: "toolbar-plugin",
      version: "1.0.0",
      contributes: {
        toolbarButtons: [
          {
            id: "my-btn",
            label: "My Button",
            iconId: "puzzle",
            actionId: "toolbar-plugin.doThing",
            priority: 4,
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    const config = getToolbarButtonConfig("plugin.toolbar-plugin.my-btn");
    expect(config).toBeDefined();
    expect(config).toMatchObject({
      id: "plugin.toolbar-plugin.my-btn",
      label: "My Button",
      iconId: "puzzle",
      actionId: "toolbar-plugin.doThing",
      priority: 4,
      pluginId: "toolbar-plugin",
    });
  });

  it("defaults priority to 3 when omitted", async () => {
    await writePlugin("default-prio", {
      name: "default-prio",
      version: "1.0.0",
      contributes: {
        toolbarButtons: [
          {
            id: "btn",
            label: "Btn",
            iconId: "icon",
            actionId: "default-prio.action",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    expect(getToolbarButtonConfig("plugin.default-prio.btn")?.priority).toBe(3);
  });
});

describe("PluginService integration — menu item contributions", () => {
  it("registers a menu item in the real pluginMenuRegistry", async () => {
    await writePlugin("menu-plugin", {
      name: "menu-plugin",
      version: "1.0.0",
      contributes: {
        menuItems: [
          {
            label: "Do Something",
            actionId: "menu-plugin.doSomething",
            location: "terminal",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    const items = getPluginMenuItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      pluginId: "menu-plugin",
      item: {
        label: "Do Something",
        actionId: "menu-plugin.doSomething",
        location: "terminal",
      },
    });
  });
});

describe("PluginService integration — main entry execution", () => {
  it("executes a plugin's main entry via dynamic import", async () => {
    const markerKey = makeMarkerKey();
    const pluginDir = await writePlugin("main-plugin", {
      name: "main-plugin",
      version: "1.0.0",
    });
    const mainFile = await writeMainFixture(pluginDir, markerKey);

    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "main-plugin",
        version: "1.0.0",
        main: mainFile,
      })
    );

    expect(readMarker(markerKey)).toBeUndefined();

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    expect(readMarker(markerKey)).toBe(1);
  });

  it("registers contributions even when main entry import throws", async () => {
    const pluginDir = await writePlugin("bad-main", {
      name: "bad-main",
      version: "1.0.0",
    });
    const mainFile = `main-${randomUUID()}.mjs`;
    await fs.writeFile(
      path.join(pluginDir, mainFile),
      `throw new Error("intentional fixture failure");\n`
    );
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "bad-main",
        version: "1.0.0",
        main: mainFile,
        contributes: {
          panels: [{ id: "p", name: "P", iconId: "i", color: "#000" }],
          toolbarButtons: [{ id: "b", label: "B", iconId: "i", actionId: "bad-main.a" }],
          menuItems: [{ label: "M", actionId: "bad-main.a", location: "view" }],
        },
      })
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir, "0.0.0");
      await service.initialize();

      expect(service.hasPlugin("bad-main")).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load main entry for bad-main"),
        expect.anything()
      );
      expect(getPanelKindConfig("bad-main.p")).toBeDefined();
      expect(getToolbarButtonConfig("plugin.bad-main.b")).toBeDefined();
      expect(getPluginMenuItems()).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not import main when the path escapes the plugin directory", async () => {
    const markerKey = makeMarkerKey();
    const outsideFile = `outside-${randomUUID()}.mjs`;
    await fs.writeFile(
      path.join(tmpDir, outsideFile),
      `globalThis[${JSON.stringify(markerKey)}] = true;\n`
    );

    await writePlugin("escape-main", {
      name: "escape-main",
      version: "1.0.0",
      main: `../${outsideFile}`,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir, "0.0.0");
      await service.initialize();

      expect(service.hasPlugin("escape-main")).toBe(true);
      expect(readMarker(markerKey)).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("PluginService integration — handler dispatch", () => {
  it("registers and dispatches a handler end-to-end on a real loaded plugin", async () => {
    await writePlugin("handler-plugin", {
      name: "handler-plugin",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    expect(service.hasPlugin("handler-plugin")).toBe(true);

    service.registerHandler("handler-plugin", "ping", async (...args: unknown[]) => ({
      pong: args,
    }));

    const result = await service.dispatchHandler("handler-plugin", "ping", ["hello", 42]);
    expect(result).toEqual({ pong: ["hello", 42] });
  });

  it("dispatchHandler rejects when plugin registered no handler for the channel", async () => {
    await writePlugin("silent-plugin", {
      name: "silent-plugin",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    await expect(service.dispatchHandler("silent-plugin", "nope", [])).rejects.toThrow(
      "No plugin handler registered for silent-plugin:nope"
    );
  });
});

describe("PluginService integration — full contribution fan-out", () => {
  it("loads a plugin with panel, toolbar, menu, and main entry in one initialize call", async () => {
    const markerKey = makeMarkerKey();
    const pluginDir = await writePlugin("all-in-one", {
      name: "all-in-one",
      version: "1.0.0",
    });
    const mainFile = await writeMainFixture(pluginDir, markerKey);

    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "all-in-one",
        version: "1.0.0",
        main: mainFile,
        contributes: {
          panels: [{ id: "v", name: "V", iconId: "eye", color: "#abc" }],
          toolbarButtons: [
            { id: "b", label: "B", iconId: "i", actionId: "all-in-one.act", priority: 2 },
          ],
          menuItems: [{ label: "M", actionId: "all-in-one.act", location: "view" }],
        },
      })
    );

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    expect(getPanelKindConfig("all-in-one.v")?.extensionId).toBe("all-in-one");
    expect(getToolbarButtonConfig("plugin.all-in-one.b")?.priority).toBe(2);
    expect(getPluginMenuItems()).toEqual([
      {
        pluginId: "all-in-one",
        item: { label: "M", actionId: "all-in-one.act", location: "view" },
      },
    ]);
    expect(readMarker(markerKey)).toBe(1);
  });
});
