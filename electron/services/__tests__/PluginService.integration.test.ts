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
import type { PluginIpcContext } from "../../../shared/types/plugin.js";
import {
  clearPanelKindRegistry,
  getPanelKindConfig,
} from "../../../shared/config/panelKindRegistry.js";
import {
  clearToolbarButtonRegistry,
  getToolbarButtonConfig,
} from "../../../shared/config/toolbarButtonRegistry.js";
import { clearPluginMenuRegistry, getPluginMenuItems } from "../pluginMenuRegistry.js";

function makeCtx(pluginId: string, overrides: Partial<PluginIpcContext> = {}): PluginIpcContext {
  return {
    projectId: null,
    worktreeId: null,
    webContentsId: 0,
    pluginId,
    ...overrides,
  };
}

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
    await writePlugin("acme.panel-plugin", {
      name: "acme.panel-plugin",
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

    const config = getPanelKindConfig("acme.panel-plugin.viewer");
    expect(config).toBeDefined();
    expect(config).toMatchObject({
      id: "acme.panel-plugin.viewer",
      name: "Viewer",
      iconId: "eye",
      color: "#ff0000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      showInPalette: true,
      extensionId: "acme.panel-plugin",
    });
  });

  it("registers multiple panels from one plugin with full config per panel", async () => {
    await writePlugin("acme.multi-panel", {
      name: "acme.multi-panel",
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

    expect(getPanelKindConfig("acme.multi-panel.viewer")).toMatchObject({
      id: "acme.multi-panel.viewer",
      name: "Viewer",
      iconId: "eye",
      color: "#111",
      extensionId: "acme.multi-panel",
    });
    expect(getPanelKindConfig("acme.multi-panel.editor")).toMatchObject({
      id: "acme.multi-panel.editor",
      name: "Editor",
      iconId: "pen",
      color: "#222",
      extensionId: "acme.multi-panel",
    });
  });

  it("propagates non-default panel flags through to the registry", async () => {
    await writePlugin("acme.flag-plugin", {
      name: "acme.flag-plugin",
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

    expect(getPanelKindConfig("acme.flag-plugin.custom")).toMatchObject({
      hasPty: true,
      canRestart: true,
      canConvert: true,
      showInPalette: false,
    });
  });

  it("preserves built-in panel kind configs intact after loading an extension", async () => {
    await writePlugin("acme.built-in-coexist", {
      name: "acme.built-in-coexist",
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
    expect(getPanelKindConfig("dev-preview")).toMatchObject({
      id: "dev-preview",
      iconId: "monitor",
    });
  });

  it("uses manifest.name not directory name when registering contributions", async () => {
    await writePlugin("alias-dir", {
      name: "acme.real-plugin",
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

    expect(getPanelKindConfig("acme.real-plugin.viewer")?.extensionId).toBe("acme.real-plugin");
    expect(getPanelKindConfig("alias-dir.viewer")).toBeUndefined();

    expect(getToolbarButtonConfig("plugin.acme.real-plugin.btn")?.pluginId).toBe(
      "acme.real-plugin"
    );
    expect(getToolbarButtonConfig("plugin.alias-dir.btn")).toBeUndefined();

    const items = getPluginMenuItems();
    expect(items).toHaveLength(1);
    expect(items[0].pluginId).toBe("acme.real-plugin");
  });
});

describe("PluginService integration — toolbar button contributions", () => {
  it("registers a toolbar button in the real toolbarButtonRegistry", async () => {
    await writePlugin("acme.toolbar-plugin", {
      name: "acme.toolbar-plugin",
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

    const config = getToolbarButtonConfig("plugin.acme.toolbar-plugin.my-btn");
    expect(config).toBeDefined();
    expect(config).toMatchObject({
      id: "plugin.acme.toolbar-plugin.my-btn",
      label: "My Button",
      iconId: "puzzle",
      actionId: "toolbar-plugin.doThing",
      priority: 4,
      pluginId: "acme.toolbar-plugin",
    });
  });

  it("defaults priority to 3 when omitted", async () => {
    await writePlugin("acme.default-prio", {
      name: "acme.default-prio",
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

    expect(getToolbarButtonConfig("plugin.acme.default-prio.btn")?.priority).toBe(3);
  });
});

describe("PluginService integration — menu item contributions", () => {
  it("registers a menu item in the real pluginMenuRegistry", async () => {
    await writePlugin("acme.menu-plugin", {
      name: "acme.menu-plugin",
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
      pluginId: "acme.menu-plugin",
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
    const pluginDir = await writePlugin("acme.main-plugin", {
      name: "acme.main-plugin",
      version: "1.0.0",
    });
    const mainFile = await writeMainFixture(pluginDir, markerKey);

    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.main-plugin",
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
    const pluginDir = await writePlugin("acme.bad-main", {
      name: "acme.bad-main",
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
        name: "acme.bad-main",
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

      expect(service.hasPlugin("acme.bad-main")).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load main entry for acme.bad-main"),
        expect.anything()
      );
      expect(getPanelKindConfig("acme.bad-main.p")).toBeDefined();
      expect(getToolbarButtonConfig("plugin.acme.bad-main.b")).toBeDefined();
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

    await writePlugin("acme.escape-main", {
      name: "acme.escape-main",
      version: "1.0.0",
      main: `../${outsideFile}`,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir, "0.0.0");
      await service.initialize();

      expect(service.hasPlugin("acme.escape-main")).toBe(true);
      expect(readMarker(markerKey)).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("PluginService integration — handler dispatch", () => {
  it("registers and dispatches a handler end-to-end on a real loaded plugin", async () => {
    await writePlugin("acme.handler-plugin", {
      name: "acme.handler-plugin",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    expect(service.hasPlugin("acme.handler-plugin")).toBe(true);

    service.registerHandler(
      "acme.handler-plugin",
      "ping",
      async (ctx: PluginIpcContext, ...args: unknown[]) => ({
        pong: args,
        seenPluginId: ctx.pluginId,
      })
    );

    const ctx = makeCtx("acme.handler-plugin", { webContentsId: 17 });
    const result = await service.dispatchHandler("acme.handler-plugin", "ping", ctx, ["hello", 42]);
    expect(result).toEqual({ pong: ["hello", 42], seenPluginId: "acme.handler-plugin" });
  });

  it("dispatchHandler rejects when plugin registered no handler for the channel", async () => {
    await writePlugin("acme.silent-plugin", {
      name: "acme.silent-plugin",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    await expect(
      service.dispatchHandler("acme.silent-plugin", "nope", makeCtx("acme.silent-plugin"), [])
    ).rejects.toThrow("No plugin handler registered for acme.silent-plugin:nope");
  });
});

describe("PluginService integration — activate() lifecycle", () => {
  async function writeActivateFixture(pluginDir: string, markerKey: string): Promise<string> {
    const fileName = `activate-${randomUUID()}.mjs`;
    const filePath = path.join(pluginDir, fileName);
    await fs.writeFile(
      filePath,
      `export function activate(host) {
  globalThis[${JSON.stringify(markerKey)}] = { pluginId: host.pluginId, called: true };
  host.registerHandler("probe", (ctx, ...args) => ({ ctx, args }));
  return () => {
    globalThis[${JSON.stringify(markerKey)}].cleaned = true;
  };
}
`
    );
    return fileName;
  }

  it("calls exported activate(host) and registers handlers via host.registerHandler", async () => {
    const markerKey = makeMarkerKey();
    const pluginDir = await writePlugin("acme.activating-plugin", {
      name: "acme.activating-plugin",
      version: "1.0.0",
    });
    const mainFile = await writeActivateFixture(pluginDir, markerKey);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.activating-plugin",
        version: "1.0.0",
        main: mainFile,
      })
    );

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    const marker = readMarker(markerKey) as { pluginId: string; called: boolean } | undefined;
    expect(marker).toBeDefined();
    expect(marker?.pluginId).toBe("acme.activating-plugin");
    expect(marker?.called).toBe(true);

    const result = (await service.dispatchHandler(
      "acme.activating-plugin",
      "probe",
      makeCtx("acme.activating-plugin", { webContentsId: 99 }),
      ["hello"]
    )) as { ctx: PluginIpcContext; args: unknown[] };
    expect(result.ctx.pluginId).toBe("acme.activating-plugin");
    expect(result.ctx.webContentsId).toBe(99);
    expect(result.args).toEqual(["hello"]);
  });

  it("invokes activate's returned cleanup before handlers are removed on unload", async () => {
    const markerKey = makeMarkerKey();
    const pluginDir = await writePlugin("acme.cleanup-plugin", {
      name: "acme.cleanup-plugin",
      version: "1.0.0",
    });
    const mainFile = await writeActivateFixture(pluginDir, markerKey);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.cleanup-plugin",
        version: "1.0.0",
        main: mainFile,
      })
    );

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    const marker = readMarker(markerKey) as
      | { pluginId: string; called: boolean; cleaned?: boolean }
      | undefined;
    expect(marker?.cleaned).toBeUndefined();

    service.unloadPlugin("acme.cleanup-plugin");

    const afterMarker = readMarker(markerKey) as
      | { pluginId: string; called: boolean; cleaned?: boolean }
      | undefined;
    expect(afterMarker?.cleaned).toBe(true);
    expect(service.hasPlugin("acme.cleanup-plugin")).toBe(false);
  });

  it("loads plugins that do not export activate without throwing", async () => {
    const markerKey = makeMarkerKey();
    const pluginDir = await writePlugin("acme.no-activate", {
      name: "acme.no-activate",
      version: "1.0.0",
    });
    const mainFile = `side-effect-${randomUUID()}.mjs`;
    await fs.writeFile(
      path.join(pluginDir, mainFile),
      `globalThis[${JSON.stringify(markerKey)}] = true;\n`
    );
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.no-activate",
        version: "1.0.0",
        main: mainFile,
      })
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir, "0.0.0");
      await service.initialize();

      expect(service.hasPlugin("acme.no-activate")).toBe(true);
      expect(readMarker(markerKey)).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs an error and still registers the plugin when activate throws", async () => {
    const pluginDir = await writePlugin("acme.throwing-activate", {
      name: "acme.throwing-activate",
      version: "1.0.0",
    });
    const mainFile = `activate-throw-${randomUUID()}.mjs`;
    await fs.writeFile(
      path.join(pluginDir, mainFile),
      `export function activate() { throw new Error("boom"); }\n`
    );
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.throwing-activate",
        version: "1.0.0",
        main: mainFile,
      })
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir, "0.0.0");
      await service.initialize();

      expect(service.hasPlugin("acme.throwing-activate")).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load main entry for acme.throwing-activate"),
        expect.anything()
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("host.registerHandler enforces the plugin's own namespace", async () => {
    const markerKey = makeMarkerKey();
    const pluginDir = await writePlugin("acme.namespace-plugin", {
      name: "acme.namespace-plugin",
      version: "1.0.0",
    });
    const mainFile = `namespace-${randomUUID()}.mjs`;
    await fs.writeFile(
      path.join(pluginDir, mainFile),
      `export function activate(host) {
  globalThis[${JSON.stringify(markerKey)}] = { pluginId: host.pluginId };
  host.registerHandler("ping", () => "pong");
}
`
    );
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.namespace-plugin",
        version: "1.0.0",
        main: mainFile,
      })
    );

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    const marker = readMarker(markerKey) as { pluginId: string } | undefined;
    expect(marker?.pluginId).toBe("acme.namespace-plugin");

    const result = await service.dispatchHandler(
      "acme.namespace-plugin",
      "ping",
      makeCtx("acme.namespace-plugin"),
      []
    );
    expect(result).toBe("pong");
  });
});

describe("PluginService integration — full contribution fan-out", () => {
  it("loads a plugin with panel, toolbar, menu, and main entry in one initialize call", async () => {
    const markerKey = makeMarkerKey();
    const pluginDir = await writePlugin("acme.all-in-one", {
      name: "acme.all-in-one",
      version: "1.0.0",
    });
    const mainFile = await writeMainFixture(pluginDir, markerKey);

    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.all-in-one",
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

    expect(getPanelKindConfig("acme.all-in-one.v")?.extensionId).toBe("acme.all-in-one");
    expect(getToolbarButtonConfig("plugin.acme.all-in-one.b")?.priority).toBe(2);
    expect(getPluginMenuItems()).toEqual([
      {
        pluginId: "acme.all-in-one",
        item: { label: "M", actionId: "all-in-one.act", location: "view" },
      },
    ]);
    expect(readMarker(markerKey)).toBe(1);
  });
});
