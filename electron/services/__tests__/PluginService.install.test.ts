import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

/**
 * Unit test for the atomic plugin installer (#9292).
 *
 * Exercises `PluginService.installPlugin` against real `.dntr` archives (packed
 * via the real `packPluginArchive`), a real temp plugins root, and the real
 * file lock — only the module-scope Electron/registry singletons are mocked, so
 * the actual filesystem extract/validate/swap/rollback logic runs unmocked.
 * Covers the happy path, every structured-error branch, the upgrade swap,
 * settings preservation, and that no half-written state is left behind.
 *
 * Mocks mirror `PluginService.test.ts`: `electron`, `windowRef`, `store`,
 * `ProjectStore`, the contribution registries, and `PluginMcpSupervisor` are
 * all imported at module scope by `PluginService`.
 */

const appMock = vi.hoisted(() => ({
  getVersion: vi.fn(() => "0.0.0"),
  getPath: vi.fn(() => "/tmp/daintree-install-test-userdata"),
}));
const storeMock = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => state.get(key)),
    set: vi.fn((key: string, value: unknown) => state.set(key, value)),
    _state: state,
  };
});

vi.mock("electron", () => ({ app: appMock, ipcMain: { on: vi.fn(), removeListener: vi.fn() } }));
vi.mock("../../window/windowRef.js", () => ({
  getWindowRegistry: vi.fn(() => null),
  getProjectViewManager: vi.fn(() => null),
  setWindowRegistry: vi.fn(),
  setMainWindow: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setProjectViewManager: vi.fn(),
}));
vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: vi.fn() }));
vi.mock("../../store.js", () => ({ store: storeMock }));
vi.mock("../ProjectStore.js", () => ({ projectStore: { getCurrentProject: vi.fn(() => null) } }));
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
  getPluginMenuItems: vi.fn(() => []),
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
vi.mock("../fileDecorationRegistry.js", () => ({
  registerFileDecorationProviders: vi.fn(),
  registerFileDecorationProviderImpl: vi.fn(),
  unregisterFileDecorationProviders: vi.fn(),
  unregisterFileDecorationProviderImpls: vi.fn(),
  unregisterFileDecorationProviderImpl: vi.fn(),
  scopeMatchesPattern: vi.fn((s: string, p: string) => s === p),
}));
vi.mock("../PluginMcpSupervisor.js", () => ({
  getPluginMcpSupervisor: () => ({
    start: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    shutdownAll: vi.fn(async () => undefined),
    callTool: vi.fn(),
    restart: vi.fn(),
    list: vi.fn(() => []),
    getStderr: vi.fn(() => ({ pluginId: "", serverId: "", lines: [], totalLines: 0 })),
  }),
}));
// resilientRename is spied (default = real impl) so the swap-rollback test can
// force the move-in rename to fail while leaving every other call real.
vi.mock("../../utils/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/fs.js")>();
  return { ...actual, resilientRename: vi.fn(actual.resilientRename) };
});

import { PluginService } from "../PluginService.js";
import { packPluginArchive } from "../PluginArchive.js";
import { resilientRename } from "../../utils/fs.js";

const storeState = storeMock._state;

let tmpDir: string;
let pluginsRoot: string;

interface ManifestShape {
  name: string;
  version: string;
  [key: string]: unknown;
}

async function makeSourceDir(
  manifest: ManifestShape,
  extraFiles: Record<string, string> = {}
): Promise<string> {
  const src = await fs.mkdtemp(path.join(tmpDir, "src-"));
  await fs.writeFile(path.join(src, "plugin.json"), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = path.join(src, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return src;
}

async function makeArchive(
  manifest: ManifestShape,
  extraFiles: Record<string, string> = {}
): Promise<string> {
  const src = await makeSourceDir(manifest, extraFiles);
  const out = path.join(tmpDir, `${manifest.name}-${manifest.version}.dntr`);
  await packPluginArchive(src, out);
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-install-test-"));
  pluginsRoot = path.join(tmpDir, "plugins");
});

afterEach(async () => {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } finally {
    storeState.clear();
    vi.clearAllMocks();
  }
});

describe("installPlugin — happy path", () => {
  it("installs a valid .dntr archive, records provenance, and lands the directory", async () => {
    const archive = await makeArchive(
      { name: "acme.installer-ok", version: "1.0.0", displayName: "OK" },
      { "dist/index.js": "module.exports = {};" }
    );
    const service = new PluginService(pluginsRoot, "0.0.0");

    const result = await service.installPlugin(archive, { source: "catalog" });

    expect(result).toEqual({ status: "installed", pluginId: "acme.installer-ok" });
    expect(await exists(path.join(pluginsRoot, "acme.installer-ok", "plugin.json"))).toBe(true);

    const installed = (storeState.get("plugins") as { installed: Record<string, unknown> })
      .installed["acme.installer-ok"] as { source: string; archiveHash: string | null };
    expect(installed.source).toBe("catalog");
    expect(installed.archiveHash).toMatch(/^[a-f0-9]{64}$/);

    service.dispose();
  });

  it("installs from a pre-extracted directory with a null archive hash", async () => {
    const src = await makeSourceDir({ name: "acme.dir-install", version: "1.0.0" });
    const service = new PluginService(pluginsRoot, "0.0.0");

    const result = await service.installPlugin(src);

    expect(result).toEqual({ status: "installed", pluginId: "acme.dir-install" });
    const installed = (storeState.get("plugins") as { installed: Record<string, unknown> })
      .installed["acme.dir-install"] as { archiveHash: string | null; source: string };
    expect(installed.archiveHash).toBeNull();
    expect(installed.source).toBe("sideload");

    service.dispose();
  });

  it("leaves no temp or parked directories behind after a successful install", async () => {
    const archive = await makeArchive({ name: "acme.clean", version: "1.0.0" });
    const service = new PluginService(pluginsRoot, "0.0.0");

    await service.installPlugin(archive);

    const entries = await fs.readdir(pluginsRoot);
    expect(entries.filter((e) => e.startsWith(".install-tmp-"))).toHaveLength(0);
    expect(entries.filter((e) => e.includes(".old-"))).toHaveLength(0);
    expect(entries).toContain("acme.clean");

    service.dispose();
  });
});

describe("installPlugin — validation failures (rollback)", () => {
  it("rejects an unknown top-level manifest key without writing a directory", async () => {
    const archive = await makeArchive({
      name: "acme.bad-key",
      version: "1.0.0",
      bogusUnknownKey: true,
    });
    const service = new PluginService(pluginsRoot, "0.0.0");

    const result = await service.installPlugin(archive);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errors.some((e) => e.code === "manifest_invalid")).toBe(true);
    }
    expect(await exists(path.join(pluginsRoot, "acme.bad-key"))).toBe(false);

    service.dispose();
  });

  it("rejects a reserved daintree.* namespace with namespace_unauthorized", async () => {
    const archive = await makeArchive({ name: "daintree.evil", version: "1.0.0" });
    const service = new PluginService(pluginsRoot, "0.0.0");

    const result = await service.installPlugin(archive);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errors.some((e) => e.code === "namespace_unauthorized")).toBe(true);
    }
    expect(await exists(path.join(pluginsRoot, "daintree.evil"))).toBe(false);

    service.dispose();
  });

  it("rejects an incompatible engines.daintree range", async () => {
    const archive = await makeArchive({
      name: "acme.future",
      version: "1.0.0",
      engines: { daintree: ">=99.0.0" },
    });
    const service = new PluginService(pluginsRoot, "0.0.0");

    const result = await service.installPlugin(archive);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errors[0].code).toBe("engine_incompatible");
    }
    expect(await exists(path.join(pluginsRoot, "acme.future"))).toBe(false);

    service.dispose();
  });

  it("returns archive_invalid for a missing source path", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");

    const result = await service.installPlugin(path.join(tmpDir, "does-not-exist.dntr"));

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errors[0].code).toBe("archive_invalid");
    }

    service.dispose();
  });
});

describe("installPlugin — upgrade swap", () => {
  it("swaps an existing plugin to the new version and removes the old directory", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");

    const v1 = await makeArchive({ name: "acme.upgrade", version: "1.0.0" }, { "v1.txt": "one" });
    const first = await service.installPlugin(v1);
    expect(first.status).toBe("installed");
    expect(await exists(path.join(pluginsRoot, "acme.upgrade", "v1.txt"))).toBe(true);

    const v2 = await makeArchive({ name: "acme.upgrade", version: "2.0.0" }, { "v2.txt": "two" });
    const second = await service.installPlugin(v2);
    expect(second.status).toBe("installed");

    // New version's file present, old version's file gone — a true swap, not a merge.
    expect(await exists(path.join(pluginsRoot, "acme.upgrade", "v2.txt"))).toBe(true);
    expect(await exists(path.join(pluginsRoot, "acme.upgrade", "v1.txt"))).toBe(false);

    const entries = await fs.readdir(pluginsRoot);
    expect(entries.filter((e) => e.includes(".old-"))).toHaveLength(0);

    service.dispose();
  });

  it("preserves the plugin's separate settings file across an upgrade", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");

    const v1 = await makeArchive({ name: "acme.keep-settings", version: "1.0.0" });
    await service.installPlugin(v1);

    // Settings live under a sibling `plugin-settings/` root, never inside the
    // plugin dir, so the directory swap must not touch them.
    const settingsRoot = path.join(tmpDir, "plugin-settings");
    await fs.mkdir(settingsRoot, { recursive: true });
    const settingsFile = path.join(settingsRoot, "acme.keep-settings.json");
    await fs.writeFile(settingsFile, JSON.stringify({ apiKey: "secret-token" }));

    const v2 = await makeArchive({ name: "acme.keep-settings", version: "2.0.0" });
    await service.installPlugin(v2);

    expect(await exists(settingsFile)).toBe(true);
    expect(JSON.parse(await fs.readFile(settingsFile, "utf-8"))).toEqual({
      apiKey: "secret-token",
    });

    service.dispose();
  });

  it("restores the old plugin's runtime state when the swap rolls back", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");

    const v1 = await makeArchive({ name: "acme.rollback", version: "1.0.0" }, { "v1.txt": "one" });
    expect((await service.installPlugin(v1)).status).toBe("installed");
    expect(service.listPlugins().some((p) => p.manifest.name === "acme.rollback")).toBe(true);

    // Fail the move-in rename (2nd call) so the swap rolls back: 1=park-aside,
    // 2=move-new-in (throws), 3=restore-parked. Real impl for park + restore.
    const real = (await vi.importActual<typeof import("../../utils/fs.js")>("../../utils/fs.js"))
      .resilientRename;
    vi.mocked(resilientRename)
      .mockImplementationOnce((s, d) => real(s, d))
      .mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" }))
      )
      .mockImplementationOnce((s, d) => real(s, d));

    const v2 = await makeArchive({ name: "acme.rollback", version: "2.0.0" }, { "v2.txt": "two" });
    const result = await service.installPlugin(v2);

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.errors[0].code).toBe("swap_failed");
    // On-disk rollback: the old version is restored, no parked dir leaks.
    expect(await exists(path.join(pluginsRoot, "acme.rollback", "v1.txt"))).toBe(true);
    expect(await exists(path.join(pluginsRoot, "acme.rollback", "v2.txt"))).toBe(false);
    expect((await fs.readdir(pluginsRoot)).filter((e) => e.includes(".old-"))).toHaveLength(0);
    // Runtime rollback: the old plugin is loaded again, not left torn down.
    expect(service.listPlugins().some((p) => p.manifest.name === "acme.rollback")).toBe(true);

    service.dispose();
  });
});

describe("installPlugin — load + provenance edge cases", () => {
  it("returns load_failed (not an unhandled rejection) when a manifest field throws downstream", async () => {
    // A malformed `when` expression passes the schema (any non-empty string)
    // but throws in the when-clause parser during loadPlugin.
    const archive = await makeArchive({
      name: "acme.bad-when",
      version: "1.0.0",
      contributes: {
        menuItems: [
          { label: "Run", location: "terminal", actionId: "acme.bad-when.run", when: "foo &&" },
        ],
      },
    });
    const service = new PluginService(pluginsRoot, "0.0.0");

    const result = await service.installPlugin(archive);

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.errors[0].code).toBe("load_failed");
    // The swap committed; the directory is deliberately left in place.
    expect(await exists(path.join(pluginsRoot, "acme.bad-when", "plugin.json"))).toBe(true);

    service.dispose();
  });

  it("returns installed (not load_failed) when the plugin id is disabled", async () => {
    storeState.set("plugins", { disabled: ["acme.disabled-install"] });
    const archive = await makeArchive({ name: "acme.disabled-install", version: "1.0.0" });
    const service = new PluginService(pluginsRoot, "0.0.0");

    const result = await service.installPlugin(archive);

    expect(result).toEqual({ status: "installed", pluginId: "acme.disabled-install" });
    expect(await exists(path.join(pluginsRoot, "acme.disabled-install", "plugin.json"))).toBe(true);
    const installed = (storeState.get("plugins") as { installed: Record<string, unknown> })
      .installed["acme.disabled-install"] as { source: string };
    expect(installed.source).toBe("sideload");

    service.dispose();
  });

  it("clears archiveHash when an archive install is replaced by a directory install", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");

    const archive = await makeArchive({ name: "acme.rehash", version: "1.0.0" });
    await service.installPlugin(archive);
    const afterArchive = (storeState.get("plugins") as { installed: Record<string, unknown> })
      .installed["acme.rehash"] as { archiveHash: string | null };
    expect(afterArchive.archiveHash).toMatch(/^[a-f0-9]{64}$/);

    const dir = await makeSourceDir({ name: "acme.rehash", version: "2.0.0" });
    await service.installPlugin(dir);
    const afterDir = (storeState.get("plugins") as { installed: Record<string, unknown> })
      .installed["acme.rehash"] as { archiveHash: string | null };
    expect(afterDir.archiveHash).toBeNull();

    service.dispose();
  });
});
