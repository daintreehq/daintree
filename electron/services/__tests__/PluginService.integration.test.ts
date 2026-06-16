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

const storeState = new Map<string, unknown>();
vi.mock("electron", () => ({
  // getPath is needed because importing PluginService transitively constructs
  // the eager ProjectStore singleton (which reads app.getPath("userData")).
  // The path is never written to disk in these tests — ProjectStore only does
  // I/O in initialize(), which they don't call.
  app: { getVersion: vi.fn(() => "0.0.0"), getPath: vi.fn(() => "/tmp/daintree-plugin-int") },
}));
vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
}));
vi.mock("../../store.js", () => ({
  store: {
    get: (key: string) => storeState.get(key),
    set: (key: string, value: unknown) => storeState.set(key, value),
  },
}));

// Every plugin activates out-of-process via utilityProcess.fork (#10526), which
// vitest can't run. Mock the worker host/bridge so the bridge imports the
// fixture bundle and runs `activate(host)` IN-PROCESS against the real host —
// preserving this suite's end-to-end coverage of real contribution registries.
const devWorkerMock = vi.hoisted(() => {
  interface DevWorkerOpts {
    pluginId: string;
    pluginDir: string;
    bundlePath: string;
    mode?: "dev" | "prod";
  }
  class MockPluginDevWorkerHost {
    opts: DevWorkerOpts;
    start = vi.fn(async () => undefined);
    dispose = vi.fn();
    isReady = (): boolean => true;
    on = vi.fn();
    off = vi.fn();
    constructor(opts: DevWorkerOpts) {
      this.opts = opts;
    }
  }
  interface MockBridgeDeps {
    workerHost: { opts: DevWorkerOpts };
    host: unknown;
    onActivationResult?: (
      result: { ok: true } | { ok: false; error: string; stack?: string }
    ) => void;
  }
  class MockPluginDevWorkerMainBridge {
    deps: MockBridgeDeps;
    private cleanup: (() => void) | null = null;
    waitForActivation = vi.fn(async () => {
      const bundlePath = this.deps.workerHost?.opts?.bundlePath;
      const onResult = this.deps.onActivationResult;
      if (!bundlePath) {
        onResult?.({ ok: true });
        return;
      }
      const { pathToFileURL } = await import("node:url");
      const { formatErrorMessage } = await import("../../../shared/utils/errorMessage.js");
      try {
        const mod = (await import(pathToFileURL(bundlePath).href)) as { activate?: unknown };
        if (typeof mod.activate === "function") {
          const result = await (mod.activate as (h: unknown) => unknown)(this.deps.host);
          if (typeof result === "function") this.cleanup = result as () => void;
        }
        onResult?.({ ok: true });
      } catch (err) {
        onResult?.({
          ok: false,
          error: formatErrorMessage(err, "activate() threw"),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    });
    dispose = vi.fn(() => {
      try {
        this.cleanup?.();
      } catch {
        // best-effort
      }
      this.cleanup = null;
    });
    constructor(deps: MockBridgeDeps) {
      this.deps = deps;
    }
  }
  return { MockPluginDevWorkerHost, MockPluginDevWorkerMainBridge };
});
vi.mock("../plugin/PluginDevWorkerHost.js", () => ({
  PluginDevWorkerHost: devWorkerMock.MockPluginDevWorkerHost,
  CRASH_WINDOW_MS: 30 * 60 * 1000,
}));
vi.mock("../plugin/PluginDevWorkerMainBridge.js", () => ({
  PluginDevWorkerMainBridge: devWorkerMock.MockPluginDevWorkerMainBridge,
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
import {
  clearForgeProviderRegistry,
  getRegisteredForgeProviders,
  listMatchingProviders,
} from "../forgeProviderRegistry.js";
import {
  clearFileDecorationImplRegistry,
  clearFileDecorationRegistry,
  getFileDecorationImpls,
  getRegisteredFileDecorationProviders,
} from "../fileDecorationRegistry.js";
import {
  clearPluginAgentRegistryForTests,
  getPluginAgentRegistry,
} from "../../../shared/config/pluginAgentRegistry.js";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { broadcastToRenderer } from "../../ipc/utils.js";

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
  capabilities?: string[];
  contributes?: {
    panels?: unknown[];
    toolbarButtons?: unknown[];
    menuItems?: unknown[];
    views?: unknown[];
    mcpServers?: unknown[];
    forgeProviders?: unknown[];
    fileDecorationProviders?: unknown[];
    agents?: unknown[];
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

async function initializeAndActivate(service: PluginService): Promise<void> {
  await service.initialize();
  await service.activateStartupFinishedPlugins();
  // Lazy by default (#10523): plugins without `activationEvents` no longer
  // activate via the startup fan-out. These integration fixtures exercise
  // activated-plugin behavior, so explicitly activate every loaded plugin.
  // `activatePlugin` is a no-op for disabled plugins (rejected at scan, never
  // in the registry) and idempotent for any already activated above.
  for (const plugin of service.listPlugins()) {
    await service.activatePlugin(plugin.manifest.name);
  }
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
    clearForgeProviderRegistry();
    clearFileDecorationRegistry();
    clearFileDecorationImplRegistry();
    clearPluginAgentRegistryForTests();
    storeState.clear();
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
    expect(getPanelKindConfig("browser")).toMatchObject({
      id: "browser",
      iconId: "globe",
      hasPty: false,
      showInPalette: true,
    });
    expect(getPanelKindConfig("dev-preview")).toMatchObject({
      id: "dev-preview",
      iconId: "monitor-play",
    });
  });

  it("uses manifest.name not directory name when registering contributions", async () => {
    await writePlugin("alias-dir", {
      name: "acme.real-plugin",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#abc" }],
        toolbarButtons: [
          { id: "btn", label: "B", iconId: "i", actionId: "acme.real-plugin.act", priority: 2 },
        ],
        menuItems: [{ label: "M", actionId: "acme.real-plugin.act", location: "view" }],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    expect(getPanelKindConfig("acme.real-plugin.viewer")?.extensionId).toBe("acme.real-plugin");
    expect(getPanelKindConfig("alias-dir.viewer")).toBeUndefined();

    expect(getToolbarButtonConfig("acme.real-plugin.btn")?.pluginId).toBe("acme.real-plugin");
    expect(getToolbarButtonConfig("alias-dir.btn")).toBeUndefined();

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
            actionId: "acme.toolbar-plugin.doThing",
            priority: 4,
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    const config = getToolbarButtonConfig("acme.toolbar-plugin.my-btn");
    expect(config).toBeDefined();
    expect(config).toMatchObject({
      id: "acme.toolbar-plugin.my-btn",
      label: "My Button",
      iconId: "puzzle",
      actionId: "acme.toolbar-plugin.doThing",
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
            actionId: "acme.default-prio.action",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    expect(getToolbarButtonConfig("acme.default-prio.btn")?.priority).toBe(3);
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
            actionId: "acme.menu-plugin.doSomething",
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
        actionId: "acme.menu-plugin.doSomething",
        location: "terminal",
      },
    });
  });
});

describe("PluginService integration — forge provider contributions", () => {
  it("registers a manifest forgeProviders entry and unregisters it on unload", async () => {
    await writePlugin("acme.forge-plugin", {
      name: "acme.forge-plugin",
      version: "1.0.0",
      contributes: {
        forgeProviders: [
          {
            id: "github",
            name: "GitHub",
            matches: ["github.com"],
            capabilities: ["issues", "pulls"],
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    const registered = getRegisteredForgeProviders();
    expect(registered).toHaveLength(1);
    expect(registered[0]).toEqual({
      pluginId: "acme.forge-plugin",
      contribution: {
        id: "github",
        name: "GitHub",
        matches: ["github.com"],
        capabilities: ["issues", "pulls"],
      },
    });

    const matches = listMatchingProviders("https://github.com/owner/repo.git");
    expect(matches).toHaveLength(1);
    expect(matches[0].pluginId).toBe("acme.forge-plugin");

    service.unloadPlugin("acme.forge-plugin");

    expect(getRegisteredForgeProviders()).toHaveLength(0);
    expect(listMatchingProviders("https://github.com/owner/repo.git")).toEqual([]);
  });

  it("registers multiple forgeProviders entries from one manifest", async () => {
    await writePlugin("acme.multi-forge", {
      name: "acme.multi-forge",
      version: "1.0.0",
      contributes: {
        forgeProviders: [
          { id: "primary", name: "Primary", matches: ["primary.example"] },
          { id: "secondary", name: "Secondary", matches: ["secondary.example"] },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    expect(getRegisteredForgeProviders()).toHaveLength(2);
    expect(listMatchingProviders("https://primary.example/repo")).toHaveLength(1);
    expect(listMatchingProviders("https://secondary.example/repo")).toHaveLength(1);
  });
});

describe("PluginService integration — agent contributions (issue #9560)", () => {
  it("registers a manifest agents entry and unregisters it on unload", async () => {
    await writePlugin("acme.agent-plugin", {
      name: "acme.agent-plugin",
      version: "1.0.0",
      capabilities: ["agent:register"],
      contributes: {
        agents: [
          {
            id: "acme-agent",
            name: "Acme Agent",
            command: "acme",
            args: ["--flag"],
            color: "#3366ff",
            iconId: "terminal",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    // Flush the coalesced microtask broadcast scheduled on load.
    await Promise.resolve();

    expect(getPluginAgentRegistry()["acme-agent"]).toBeDefined();
    const config = getEffectiveAgentConfig("acme-agent");
    expect(config?.name).toBe("Acme Agent");
    expect(config?.command).toBe("acme");

    expect(vi.mocked(broadcastToRenderer)).toHaveBeenCalledWith("events:push", {
      name: "plugin:agents-changed",
      payload: {
        agents: expect.objectContaining({ "acme-agent": expect.anything() }),
        complete: false,
      },
    });

    vi.mocked(broadcastToRenderer).mockClear();
    service.unloadPlugin("acme.agent-plugin");
    await Promise.resolve();

    expect(getPluginAgentRegistry()["acme-agent"]).toBeUndefined();
    expect(getEffectiveAgentConfig("acme-agent")).toBeUndefined();
    expect(vi.mocked(broadcastToRenderer)).toHaveBeenCalledWith(
      "events:push",
      expect.objectContaining({
        name: "plugin:agents-changed",
        payload: expect.objectContaining({ complete: true }),
      })
    );
  });

  it("does not register agents when the manifest omits the agent:register capability", async () => {
    await writePlugin("acme.no-cap", {
      name: "acme.no-cap",
      version: "1.0.0",
      contributes: {
        agents: [
          {
            id: "uncapped-agent",
            name: "Uncapped",
            command: "uncapped",
            color: "#3366ff",
            iconId: "terminal",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    // The manifest fails strict validation (capability gate), so the plugin
    // never loads its agent into the registry.
    expect(getPluginAgentRegistry()["uncapped-agent"]).toBeUndefined();
  });
});

describe("PluginService integration — file decoration provider contributions", () => {
  it("registers a manifest fileDecorationProviders entry and unregisters it on unload", async () => {
    await writePlugin("acme.decor-plugin", {
      name: "acme.decor-plugin",
      version: "1.0.0",
      contributes: {
        fileDecorationProviders: [{ id: "badges", scopes: ["my-scope:*"] }],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    const registered = getRegisteredFileDecorationProviders();
    expect(registered).toEqual([
      {
        pluginId: "acme.decor-plugin",
        contribution: { id: "badges", scopes: ["my-scope:*"] },
      },
    ]);

    service.unloadPlugin("acme.decor-plugin");
    expect(getRegisteredFileDecorationProviders()).toEqual([]);
  });

  it("serves a non-GitHub plugin's decorations opaquely and broadcasts invalidation", async () => {
    // This is the acceptance proof: the host wires through a fake plugin's
    // decorations with zero knowledge of what they represent (no review
    // threads, no GitHub) and rebroadcasts its invalidation signal.
    const pluginDir = await writePlugin("acme.decor-plugin", {
      name: "acme.decor-plugin",
      version: "1.0.0",
    });
    const mainFile = `decor-${randomUUID()}.mjs`;
    await fs.writeFile(
      path.join(pluginDir, mainFile),
      `export function activate(host) {
  const dispose = host.registerFileDecorationProvider({ id: "badges" }, {
    async provideDecorations(scope, paths) {
      const out = {};
      for (const p of paths) out[p] = { badge: "★", tooltip: "fake:" + scope };
      return out;
    },
  });
  host.invalidateFileDecorations("my-scope:/x", ["a.ts"]);
  return dispose;
}
`
    );
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.decor-plugin",
        version: "1.0.0",
        main: mainFile,
        contributes: {
          fileDecorationProviders: [{ id: "badges", scopes: ["my-scope:*"] }],
        },
      })
    );

    const service = new PluginService(tmpDir, "0.0.0");
    await initializeAndActivate(service);

    const impls = getFileDecorationImpls("my-scope:/x");
    expect(impls).toHaveLength(1);
    expect(impls[0]).toMatchObject({
      pluginId: "acme.decor-plugin",
      contributionId: "badges",
    });

    const decorations = await impls[0].impl.provideDecorations("my-scope:/x", ["a.ts", "b.ts"]);
    expect(decorations).toEqual({
      "a.ts": { badge: "★", tooltip: "fake:my-scope:/x" },
      "b.ts": { badge: "★", tooltip: "fake:my-scope:/x" },
    });

    expect(vi.mocked(broadcastToRenderer)).toHaveBeenCalledWith("events:push", {
      name: "plugin:decorations-changed",
      payload: { scope: "my-scope:/x", paths: ["a.ts"] },
    });

    service.unloadPlugin("acme.decor-plugin");
    expect(getFileDecorationImpls("my-scope:/x")).toEqual([]);
  });

  it("caps the paths broadcast by invalidateFileDecorations (#10477)", async () => {
    // A misbehaving plugin passing an unbounded paths array must not force an
    // arbitrarily large IPC payload to every renderer. Over the cap we fall back
    // to a scope-wide invalidation (no `paths`) rather than truncating, so no
    // visible file silently misses its refresh.
    const oversized = 1500;
    const pluginDir = await writePlugin("acme.flood-decor", {
      name: "acme.flood-decor",
      version: "1.0.0",
    });
    const mainFile = `decor-${randomUUID()}.mjs`;
    await fs.writeFile(
      path.join(pluginDir, mainFile),
      `export function activate(host) {
  const paths = Array.from({ length: ${oversized} }, (_, i) => "f" + i + ".ts");
  host.invalidateFileDecorations("my-scope:/x", paths);
}
`
    );
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.flood-decor",
        version: "1.0.0",
        main: mainFile,
        contributes: {
          fileDecorationProviders: [{ id: "badges", scopes: ["my-scope:*"] }],
        },
      })
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new PluginService(tmpDir, "0.0.0");
    await initializeAndActivate(service);

    const call = vi
      .mocked(broadcastToRenderer)
      .mock.calls.find(
        ([channel, evt]) =>
          channel === "events:push" &&
          (evt as { name?: string }).name === "plugin:decorations-changed"
      );
    expect(call).toBeDefined();
    const payload = (call![1] as { payload: { scope: string; paths?: string[] } }).payload;
    // Over-cap drops `paths` entirely — a scope-wide invalidation — so the
    // renderer does an unconditional re-pull instead of missing the tail.
    expect(payload.scope).toBe("my-scope:/x");
    expect(payload.paths).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("exceeds cap"));
    warnSpy.mockRestore();
  });

  it("rejects registering a provider id not declared in the manifest", async () => {
    const pluginDir = await writePlugin("acme.bad-decor", {
      name: "acme.bad-decor",
      version: "1.0.0",
    });
    const markerKey = makeMarkerKey();
    const mainFile = `decor-${randomUUID()}.mjs`;
    await fs.writeFile(
      path.join(pluginDir, mainFile),
      `export function activate(host) {
  try {
    host.registerFileDecorationProvider({ id: "undeclared" }, { async provideDecorations() { return {}; } });
  } catch (err) {
    globalThis[${JSON.stringify(markerKey)}] = String(err && err.message);
  }
}
`
    );
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.bad-decor",
        version: "1.0.0",
        main: mainFile,
        contributes: {
          fileDecorationProviders: [{ id: "declared", scopes: ["s:*"] }],
        },
      })
    );

    const service = new PluginService(tmpDir, "0.0.0");
    await initializeAndActivate(service);

    expect(String(readMarker(markerKey))).toContain("is not declared in contributes");
    expect(getFileDecorationImpls("s:/x")).toEqual([]);
  });

  it("rejects invalidating a scope not covered by declared scopes", async () => {
    const pluginDir = await writePlugin("acme.scope-guard", {
      name: "acme.scope-guard",
      version: "1.0.0",
    });
    const markerKey = makeMarkerKey();
    const mainFile = `decor-${randomUUID()}.mjs`;
    await fs.writeFile(
      path.join(pluginDir, mainFile),
      `export function activate(host) {
  try {
    host.invalidateFileDecorations("other:/x");
  } catch (err) {
    globalThis[${JSON.stringify(markerKey)}] = String(err && err.message);
  }
}
`
    );
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.scope-guard",
        version: "1.0.0",
        main: mainFile,
        contributes: {
          fileDecorationProviders: [{ id: "d", scopes: ["allowed:*"] }],
        },
      })
    );

    const service = new PluginService(tmpDir, "0.0.0");
    await initializeAndActivate(service);

    expect(String(readMarker(markerKey))).toContain("is not covered by any declared");
  });

  it("broadcasts a decorations-changed event for each declared scope on unload", async () => {
    await writePlugin("acme.unload-decor", {
      name: "acme.unload-decor",
      version: "1.0.0",
      contributes: {
        fileDecorationProviders: [{ id: "d", scopes: ["scope-a:*", "scope-b:*"] }],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    vi.mocked(broadcastToRenderer).mockClear();

    service.unloadPlugin("acme.unload-decor");

    const decorationBroadcasts = vi
      .mocked(broadcastToRenderer)
      .mock.calls.filter(
        (c) =>
          c[0] === "events:push" &&
          (c[1] as { name?: string }).name === "plugin:decorations-changed"
      )
      .map((c) => (c[1] as { payload: { scope: string } }).payload.scope);
    expect(new Set(decorationBroadcasts)).toEqual(new Set(["scope-a:*", "scope-b:*"]));
    expect(getFileDecorationImpls("scope-a:/x")).toEqual([]);
  });

  it("invalidateFileDecorations is a silent no-op after the plugin unloads", async () => {
    const pluginDir = await writePlugin("acme.post-unload", {
      name: "acme.post-unload",
      version: "1.0.0",
    });
    const mainFile = `decor-${randomUUID()}.mjs`;
    // Stash the host so the test can call invalidate AFTER unload — the true
    // post-activation path the no-op guard protects.
    await fs.writeFile(
      path.join(pluginDir, mainFile),
      `export function activate(host) {
  globalThis.__postUnloadHost = host;
}
`
    );
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.post-unload",
        version: "1.0.0",
        main: mainFile,
        contributes: {
          fileDecorationProviders: [{ id: "d", scopes: ["live:*"] }],
        },
      })
    );

    const service = new PluginService(tmpDir, "0.0.0");
    await initializeAndActivate(service);
    const host = (globalThis as Record<string, unknown>).__postUnloadHost as {
      invalidateFileDecorations: (scope: string) => void;
    };
    service.unloadPlugin("acme.post-unload");
    vi.mocked(broadcastToRenderer).mockClear();

    expect(() => host.invalidateFileDecorations("live:/x")).not.toThrow();
    const after = vi
      .mocked(broadcastToRenderer)
      .mock.calls.filter(
        (c) => (c[1] as { name?: string } | undefined)?.name === "plugin:decorations-changed"
      );
    expect(after).toEqual([]);
    delete (globalThis as Record<string, unknown>).__postUnloadHost;
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
    await initializeAndActivate(service);

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
          toolbarButtons: [{ id: "b", label: "B", iconId: "i", actionId: "acme.bad-main.a" }],
          menuItems: [{ label: "M", actionId: "acme.bad-main.a", location: "view" }],
        },
      })
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir, "0.0.0");
      await initializeAndActivate(service);

      expect(service.hasPlugin("acme.bad-main")).toBe(true);
      // The worker reports the import failure via onActivationResult, which
      // PluginService persists as the provenance loadError (#10526) — the
      // in-process console.error of the old loader is gone.
      expect(service.getPluginLoadError("acme.bad-main")?.message).toContain(
        "intentional fixture failure"
      );
      expect(getPanelKindConfig("acme.bad-main.p")).toBeDefined();
      expect(getToolbarButtonConfig("acme.bad-main.b")).toBeDefined();
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
    await initializeAndActivate(service);

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

  it("registers a main-side action via host.registerAction and dispatches it end-to-end", async () => {
    const pluginDir = await writePlugin("acme.action-plugin", {
      name: "acme.action-plugin",
      version: "1.0.0",
    });
    const mainFile = `action-${randomUUID()}.mjs`;
    await fs.writeFile(
      path.join(pluginDir, mainFile),
      `export function activate(host) {
  host.registerAction(
    {
      id: "do-thing",
      title: "Do thing",
      description: "Does the thing",
      category: "Actions",
      kind: "command",
      danger: "safe",
    },
    async (args) => ({ echoed: args })
  );
}
`
    );
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.action-plugin",
        version: "1.0.0",
        main: mainFile,
      })
    );

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    // Activation is deferred and lazy by default (#10523): registerAction runs
    // inside activate(), so the action only surfaces once activation has run.
    // A lazy plugin activates on first use — here, dispatch would trigger it,
    // but the pre-dispatch list assertion below needs it activated up front.
    await service.activatePlugin("acme.action-plugin");

    // The action surfaces in the renderer-facing list with the namespaced id.
    expect(service.listPluginActions().map((a) => a.id)).toContain("acme.action-plugin.do-thing");

    // Dispatch lands on the main-side handler with the args payload only.
    const result = await service.dispatchHandler(
      "acme.action-plugin",
      "acme.action-plugin.do-thing",
      makeCtx("acme.action-plugin"),
      [{ issue: 7 }]
    );
    expect(result).toEqual({ echoed: { issue: 7 } });

    // Unload tears the handler down — a later dispatch is short-circuited by
    // the #10462 ownership guard (the plugin left `this.plugins`).
    service.unloadPlugin("acme.action-plugin");
    expect(service.listPluginActions()).toEqual([]);
    await expect(
      service.dispatchHandler(
        "acme.action-plugin",
        "acme.action-plugin.do-thing",
        makeCtx("acme.action-plugin"),
        [{}]
      )
    ).rejects.toThrow(/is not loaded/);
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
    await initializeAndActivate(service);

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
      await initializeAndActivate(service);

      expect(service.hasPlugin("acme.no-activate")).toBe(true);
      expect(readMarker(markerKey)).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("records a load error and still registers the plugin when activate throws", async () => {
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

    const service = new PluginService(tmpDir, "0.0.0");
    await initializeAndActivate(service);

    expect(service.hasPlugin("acme.throwing-activate")).toBe(true);
    // The worker's activate-error is persisted as the provenance loadError
    // (#10526) — the in-process console.error of the old loader is gone.
    expect(service.getPluginLoadError("acme.throwing-activate")?.message).toContain("boom");
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
    await initializeAndActivate(service);

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
            { id: "b", label: "B", iconId: "i", actionId: "acme.all-in-one.act", priority: 2 },
          ],
          menuItems: [{ label: "M", actionId: "acme.all-in-one.act", location: "view" }],
        },
      })
    );

    const service = new PluginService(tmpDir, "0.0.0");
    await initializeAndActivate(service);

    expect(getPanelKindConfig("acme.all-in-one.v")?.extensionId).toBe("acme.all-in-one");
    expect(getToolbarButtonConfig("acme.all-in-one.b")?.priority).toBe(2);
    expect(getPluginMenuItems()).toEqual([
      {
        pluginId: "acme.all-in-one",
        item: { label: "M", actionId: "acme.all-in-one.act", location: "view" },
      },
    ]);
    expect(readMarker(markerKey)).toBe(1);
  });
});

describe("PluginService integration — built-in plugin loading", () => {
  let builtinDir: string;

  async function writeBuiltinPlugin(
    pluginDirName: string,
    manifest: PluginManifestShape
  ): Promise<string> {
    const dir = path.join(builtinDir, pluginDirName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
    return dir;
  }

  beforeEach(async () => {
    builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-builtin-int-"));
  });

  afterEach(async () => {
    await fs.rm(builtinDir, { recursive: true, force: true });
  });

  it("loads contributions from both built-in and user directories into the real registries", async () => {
    await writeBuiltinPlugin("daintree.builtin-panels", {
      name: "daintree.builtin-panels",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc" }],
      },
    });
    await writePlugin("acme.user-panels", {
      name: "acme.user-panels",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "side", name: "Side", iconId: "box", color: "#def" }],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    expect(getPanelKindConfig("daintree.builtin-panels.main")?.extensionId).toBe(
      "daintree.builtin-panels"
    );
    expect(getPanelKindConfig("acme.user-panels.side")?.extensionId).toBe("acme.user-panels");

    const plugins = service.listPlugins();
    expect(plugins.find((p) => p.manifest.name === "daintree.builtin-panels")?.isBuiltin).toBe(
      true
    );
    expect(plugins.find((p) => p.manifest.name === "acme.user-panels")?.isBuiltin).toBe(false);
  });

  it("does not register contributions for a disabled built-in", async () => {
    storeState.set("plugins", { disabled: ["daintree.disabled"] });
    await writeBuiltinPlugin("daintree.disabled", {
      name: "daintree.disabled",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "x", name: "X", iconId: "eye", color: "#000" }],
        toolbarButtons: [{ id: "b", label: "B", iconId: "i", actionId: "daintree.disabled.act" }],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    expect(getPanelKindConfig("daintree.disabled.x")).toBeUndefined();
    expect(getToolbarButtonConfig("plugin.daintree.disabled.b")).toBeUndefined();
    // The plugin is still listed (as disabled) so the Preferences toggle can
    // re-enable it — only its contributions are withheld.
    const listed = service.listPlugins();
    expect(listed).toHaveLength(1);
    expect(listed[0].manifest.name).toBe("daintree.disabled");
    expect(listed[0].disabled).toBe(true);
  });

  it("activates a built-in plugin's main entry through the standard lifecycle", async () => {
    const markerKey = makeMarkerKey();
    const pluginDir = await writeBuiltinPlugin("daintree.activate-test", {
      name: "daintree.activate-test",
      version: "1.0.0",
    });
    const mainFile = await writeMainFixture(pluginDir, markerKey);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "daintree.activate-test",
        version: "1.0.0",
        main: mainFile,
      })
    );

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await initializeAndActivate(service);

    expect(readMarker(markerKey)).toBe(1);
    expect(service.listPlugins()[0].isBuiltin).toBe(true);
  });

  it("does not register contributions or run main for a disabled user plugin", async () => {
    const markerKey = makeMarkerKey();
    const pluginDir = await writePlugin("acme.disabled-user", {
      name: "acme.disabled-user",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "p", name: "P", iconId: "eye", color: "#000" }],
        toolbarButtons: [{ id: "b", label: "B", iconId: "i", actionId: "acme.disabled-user.act" }],
      },
    });
    const mainFile = await writeMainFixture(pluginDir, markerKey);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.disabled-user",
        version: "1.0.0",
        main: mainFile,
        contributes: {
          panels: [{ id: "p", name: "P", iconId: "eye", color: "#000" }],
          toolbarButtons: [
            { id: "b", label: "B", iconId: "i", actionId: "acme.disabled-user.act" },
          ],
        },
      })
    );
    storeState.set("plugins", { disabled: ["acme.disabled-user"] });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    expect(readMarker(markerKey)).toBeUndefined();
    expect(getPanelKindConfig("acme.disabled-user.p")).toBeUndefined();
    expect(getToolbarButtonConfig("acme.disabled-user.b")).toBeUndefined();
    const listed = service.listPlugins();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ disabled: true, isBuiltin: false });
  });

  it("does not execute the main entry of a disabled built-in", async () => {
    const markerKey = makeMarkerKey();
    const pluginDir = await writeBuiltinPlugin("daintree.disabled-main", {
      name: "daintree.disabled-main",
      version: "1.0.0",
    });
    const mainFile = await writeMainFixture(pluginDir, markerKey);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "daintree.disabled-main",
        version: "1.0.0",
        main: mainFile,
      })
    );
    storeState.set("plugins", { disabled: ["daintree.disabled-main"] });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    expect(readMarker(markerKey)).toBeUndefined();
    const listed = service.listPlugins();
    expect(listed).toHaveLength(1);
    expect(listed[0].manifest.name).toBe("daintree.disabled-main");
    expect(listed[0].disabled).toBe(true);
  });

  it("loads remaining built-ins and user plugins when one built-in has a malformed manifest", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const badDir = path.join(builtinDir, "broken");
      await fs.mkdir(badDir, { recursive: true });
      await fs.writeFile(path.join(badDir, "plugin.json"), "{not json");

      await writeBuiltinPlugin("daintree.good-builtin", {
        name: "daintree.good-builtin",
        version: "1.0.0",
        contributes: {
          panels: [{ id: "ok", name: "Ok", iconId: "i", color: "#abc" }],
        },
      });
      await writePlugin("acme.good-user", {
        name: "acme.good-user",
        version: "1.0.0",
      });

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      const names = service.listPlugins().map((p) => p.manifest.name);
      expect(names).toEqual(expect.arrayContaining(["daintree.good-builtin", "acme.good-user"]));
      expect(names).toHaveLength(2);
      expect(getPanelKindConfig("daintree.good-builtin.ok")).toBeDefined();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("PluginService integration — diagnostic logger", () => {
  async function loadWithLoggerActivate(
    pluginName: string,
    hostKey: string,
    activateBody: string
  ): Promise<PluginService> {
    globalMarkers.add(hostKey);
    const pluginDir = await writePlugin(pluginName, { name: pluginName, version: "1.2.3" });
    const mainFile = `logger-${randomUUID()}.mjs`;
    await fs.writeFile(
      path.join(pluginDir, mainFile),
      `export function activate(host) {\n  globalThis[${JSON.stringify(hostKey)}] = host;\n  ${activateBody}\n}\n`
    );
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: pluginName,
        version: "1.2.3",
        displayName: "Logger Plugin",
        main: mainFile,
      })
    );
    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();
    // Activation is deferred and lazy by default (#10523) — the logger is wired
    // inside activate(), so trigger first-use activation explicitly here.
    await service.activatePlugin(pluginName);
    return service;
  }

  it("captures logger lines (level, message, folded fields) in the snapshot", async () => {
    const service = await loadWithLoggerActivate(
      "acme.logger",
      "__loggerHost1",
      `host.logger.info("hello");
       host.logger.warn("careful", { code: 42 });
       host.logger.error("boom");`
    );

    const entry = service
      .getDiagnosticsSnapshot()
      .plugins.find((p) => p.pluginId === "acme.logger");
    expect(entry).toBeDefined();
    expect(entry?.displayName).toBe("Logger Plugin");
    expect(entry?.version).toBe("1.2.3");
    expect(entry?.logLines.map((l) => ({ level: l.level, message: l.message }))).toEqual([
      { level: "info", message: "hello" },
      { level: "warn", message: 'careful {"code":42}' },
      { level: "error", message: "boom" },
    ]);
    expect(entry?.logLines.every((l) => typeof l.ts === "number")).toBe(true);
  });

  it("evicts oldest lines beyond the 500-entry cap (FIFO)", async () => {
    const service = await loadWithLoggerActivate(
      "acme.logger-cap",
      "__loggerHost2",
      `for (let i = 0; i < 600; i++) host.logger.info("line-" + i);`
    );

    const entry = service
      .getDiagnosticsSnapshot()
      .plugins.find((p) => p.pluginId === "acme.logger-cap");
    expect(entry?.logLines).toHaveLength(500);
    // Oldest 100 evicted: buffer holds line-100 .. line-599.
    expect(entry?.logLines[0]?.message).toBe("line-100");
    expect(entry?.logLines.at(-1)?.message).toBe("line-599");
  });

  it("truncates a single line longer than the per-line byte cap with an ellipsis", async () => {
    const service = await loadWithLoggerActivate(
      "acme.logger-long",
      "__loggerHost3",
      `host.logger.info("x".repeat(5000));`
    );

    const entry = service
      .getDiagnosticsSnapshot()
      .plugins.find((p) => p.pluginId === "acme.logger-long");
    const line = entry?.logLines[0]?.message ?? "";
    expect(line).toHaveLength(2048);
    expect(line.endsWith("…")).toBe(true);
  });

  it("truncates multi-byte glyph lines without producing a lone surrogate", async () => {
    const service = await loadWithLoggerActivate(
      "acme.logger-emoji",
      "__loggerHost5",
      `host.logger.info("😀".repeat(3000));`
    );

    const entry = service
      .getDiagnosticsSnapshot()
      .plugins.find((p) => p.pluginId === "acme.logger-emoji");
    const line = entry?.logLines[0]?.message ?? "";
    // A lone surrogate would make encodeURIComponent throw downstream.
    expect(() => encodeURIComponent(line)).not.toThrow();
    expect(line.endsWith("…")).toBe(true);
  });

  it("keeps per-plugin log buffers isolated", async () => {
    await loadWithLoggerActivate("acme.logger-a", "__loggerHost6a", `host.logger.info("from-a");`);
    const service = await loadWithLoggerActivate(
      "acme.logger-b",
      "__loggerHost6b",
      `host.logger.info("from-b");`
    );

    const snapshot = service.getDiagnosticsSnapshot();
    const a = snapshot.plugins.find((p) => p.pluginId === "acme.logger-a");
    const b = snapshot.plugins.find((p) => p.pluginId === "acme.logger-b");
    expect(a?.logLines.map((l) => l.message)).toEqual(["from-a"]);
    expect(b?.logLines.map((l) => l.message)).toEqual(["from-b"]);
  });

  it("logger writes are a silent no-op after the plugin unloads", async () => {
    const service = await loadWithLoggerActivate(
      "acme.logger-unload",
      "__loggerHost4",
      `host.logger.info("before-unload");`
    );
    const host = (globalThis as Record<string, unknown>).__loggerHost4 as {
      logger: { info: (m: string) => void };
    };

    service.unloadPlugin("acme.logger-unload");
    // The post-unload call must not throw and must not resurrect the buffer.
    expect(() => host.logger.info("after-unload")).not.toThrow();

    const entry = service
      .getDiagnosticsSnapshot()
      .plugins.find((p) => p.pluginId === "acme.logger-unload");
    expect(entry).toBeUndefined();
  });
});

describe("PluginService integration — stale temp dir sweep", () => {
  it("reaps crash-left staging dirs at initialize() but keeps real plugins", async () => {
    await fs.mkdir(path.join(tmpDir, ".install-tmp-x"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".install-tmp-x", "leftover.txt"), "x");
    await fs.mkdir(path.join(tmpDir, ".update-check-y"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".old-z"), { recursive: true });

    await writePlugin("acme.real-plugin", {
      name: "acme.real-plugin",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#abc" }],
      },
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    const remaining = await fs.readdir(tmpDir);
    expect(remaining).not.toContain(".install-tmp-x");
    expect(remaining).not.toContain(".update-check-y");
    expect(remaining).not.toContain(".old-z");
    expect(remaining).toContain("acme.real-plugin");

    expect(getPanelKindConfig("acme.real-plugin.viewer")).toMatchObject({
      id: "acme.real-plugin.viewer",
      extensionId: "acme.real-plugin",
    });
  });
});
