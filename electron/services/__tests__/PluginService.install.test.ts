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
// Plugin-MCP consent + rate-limiter singletons are only reached by the
// installer's uninstall/upgrade purge; stub them so the upgrade-consent-reset
// test can assert the revoke without standing up the real persistence.
const consentMock = vi.hoisted(() => ({ revokeAllForPlugin: vi.fn(() => true) }));
const rateLimiterMock = vi.hoisted(() => ({ dropPlugin: vi.fn() }));

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
    removeState: vi.fn(),
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
vi.mock("../plugin-mcp/instances.js", () => ({
  getPluginMcpConsentService: () => consentMock,
  getPluginMcpRateLimiter: () => rateLimiterMock,
}));

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

  it("preserves installedAt and records updatedAt on an upgrade", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");

    const v1 = await makeArchive({ name: "acme.stamp", version: "1.0.0" });
    expect((await service.installPlugin(v1)).status).toBe("installed");
    const firstInfo = service.listPlugins().find((p) => p.manifest.name === "acme.stamp");
    expect(firstInfo).toBeDefined();
    const originalInstalledAt = firstInfo!.installedAt;
    expect(originalInstalledAt).toBeGreaterThan(0);
    // First install records no upgrade timestamp.
    expect(firstInfo!.updatedAt).toBeUndefined();

    const before = Date.now();
    const v2 = await makeArchive({ name: "acme.stamp", version: "2.0.0" });
    expect((await service.installPlugin(v2)).status).toBe("installed");

    const secondInfo = service.listPlugins().find((p) => p.manifest.name === "acme.stamp");
    expect(secondInfo).toBeDefined();
    // installedAt is preserved from the first install; updatedAt is newly set.
    expect(secondInfo!.installedAt).toBe(originalInstalledAt);
    expect(secondInfo!.updatedAt).toBeGreaterThanOrEqual(before);

    service.dispose();
  });

  it("clears a prior updateAvailable flag on a successful upgrade", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");

    const v1 = await makeArchive({ name: "acme.clearflag", version: "1.0.0" });
    expect((await service.installPlugin(v1)).status).toBe("installed");

    // Simulate an update-check having flagged an available update.
    const records = storeMock.get("plugins") as { installed?: Record<string, unknown> } | undefined;
    const installed = (records?.installed ?? {}) as Record<string, Record<string, unknown>>;
    installed["acme.clearflag"] = {
      ...installed["acme.clearflag"],
      updateAvailable: { version: "2.0.0", channel: "manual" },
    };
    storeMock.set("plugins", { ...records, installed });

    const v2 = await makeArchive({ name: "acme.clearflag", version: "2.0.0" });
    expect((await service.installPlugin(v2)).status).toBe("installed");

    const info = service.listPlugins().find((p) => p.manifest.name === "acme.clearflag");
    expect(info?.updateAvailable).toBeNull();

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

  it("restores the old version on disk and runtime when an upgrade's load fails post-swap", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");

    const v1 = await makeArchive(
      { name: "acme.up-loadfail", version: "1.0.0" },
      { "v1.txt": "one" }
    );
    expect((await service.installPlugin(v1)).status).toBe("installed");
    expect(service.listPlugins().some((p) => p.manifest.name === "acme.up-loadfail")).toBe(true);

    // v2's manifest passes the schema but throws in loadPlugin (malformed `when`).
    const v2 = await makeArchive(
      {
        name: "acme.up-loadfail",
        version: "2.0.0",
        contributes: {
          menuItems: [
            {
              label: "Run",
              location: "terminal",
              actionId: "acme.up-loadfail.run",
              when: "foo &&",
            },
          ],
        },
      },
      { "v2.txt": "two" }
    );
    const result = await service.installPlugin(v2);

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.errors[0].code).toBe("load_failed");

    // On-disk rollback: v1 restored, v2 gone, no parked dir leaks.
    expect(await exists(path.join(pluginsRoot, "acme.up-loadfail", "v1.txt"))).toBe(true);
    expect(await exists(path.join(pluginsRoot, "acme.up-loadfail", "v2.txt"))).toBe(false);
    expect((await fs.readdir(pluginsRoot)).filter((e) => e.includes(".old-"))).toHaveLength(0);

    // Runtime rollback: v1 is live again, not left torn down.
    expect(service.listPlugins().some((p) => p.manifest.name === "acme.up-loadfail")).toBe(true);

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

  it("does not leak a parked old dir when a disabled plugin is upgraded", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");

    const v1 = await makeArchive(
      { name: "acme.disabled-up", version: "1.0.0" },
      { "v1.txt": "one" }
    );
    expect((await service.installPlugin(v1)).status).toBe("installed");

    // Disable the plugin so the upgrade returns early (disabled plugins aren't
    // reloaded) — the parked old dir must still be reaped before that return.
    storeState.set("plugins", {
      ...(storeState.get("plugins") as object),
      disabled: ["acme.disabled-up"],
    });

    const v2 = await makeArchive(
      { name: "acme.disabled-up", version: "2.0.0" },
      { "v2.txt": "two" }
    );
    expect((await service.installPlugin(v2)).status).toBe("installed");

    // New version on disk, and NO parked `<pluginId>.old-<uuid>` dir left behind.
    expect(await exists(path.join(pluginsRoot, "acme.disabled-up", "v2.txt"))).toBe(true);
    expect(await exists(path.join(pluginsRoot, "acme.disabled-up", "v1.txt"))).toBe(false);
    expect((await fs.readdir(pluginsRoot)).filter((e) => e.includes(".old-"))).toHaveLength(0);

    service.dispose();
  });

  it("leaves the OLD installed record intact when an upgrade's load fails post-swap", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");

    const v1 = await makeArchive({ name: "acme.rec-rollback", version: "1.0.0" });
    expect((await service.installPlugin(v1)).status).toBe("installed");
    const before = (storeState.get("plugins") as { installed: Record<string, unknown> }).installed[
      "acme.rec-rollback"
    ] as { version?: string; archiveHash: string | null };
    const oldHash = before.archiveHash;
    expect(oldHash).toMatch(/^[a-f0-9]{64}$/);

    // v2's manifest passes the schema but throws in loadPlugin (malformed `when`),
    // so the post-swap rollback restores both the old dir AND its record.
    const v2 = await makeArchive({
      name: "acme.rec-rollback",
      version: "2.0.0",
      contributes: {
        menuItems: [
          {
            label: "Run",
            location: "terminal",
            actionId: "acme.rec-rollback.run",
            when: "foo &&",
          },
        ],
      },
    });
    const result = await service.installPlugin(v2);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.errors[0].code).toBe("load_failed");

    // The store must hold the OLD record (old hash, no new updatedAt), not the
    // failed new version — Settings + checkForUpdate baseline against this.
    const after = (storeState.get("plugins") as { installed: Record<string, unknown> }).installed[
      "acme.rec-rollback"
    ] as { archiveHash: string | null; updatedAt?: number };
    expect(after.archiveHash).toBe(oldHash);
    expect(after.updatedAt).toBeUndefined();

    service.dispose();
  });

  it("sweeps a leaked `<pluginId>.old-<uuid>` parked dir on initialize", async () => {
    await fs.mkdir(pluginsRoot, { recursive: true });
    // A real plugin and a leaked parked dir from a prior crashed upgrade.
    const realDir = path.join(pluginsRoot, "acme.survivor");
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(
      path.join(realDir, "plugin.json"),
      JSON.stringify({ name: "acme.survivor", version: "1.0.0" })
    );
    const parked = path.join(pluginsRoot, "acme.survivor.old-12345678-1234-4123-8123-1234567890ab");
    await fs.mkdir(parked, { recursive: true });

    const service = new PluginService(pluginsRoot, "0.0.0");
    await service.initialize();

    // Parked dir reaped; the real plugin dir untouched.
    expect(await exists(parked)).toBe(false);
    expect(await exists(realDir)).toBe(true);

    service.dispose();
  });

  it("loads the live plugin, not a parked `<pluginId>.old-<uuid>` copy that carries plugin.json", async () => {
    await fs.mkdir(pluginsRoot, { recursive: true });
    // The parked copy carries a valid plugin.json with the SAME name as the
    // live install — exactly the crash-leftover that could win the duplicate
    // race and get the live dir reaped if the sweep ran after the scan and the
    // scan didn't defensively skip the parked name.
    const realDir = path.join(pluginsRoot, "acme.survivor");
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(
      path.join(realDir, "plugin.json"),
      JSON.stringify({ name: "acme.survivor", version: "2.0.0" })
    );
    const parked = path.join(pluginsRoot, "acme.survivor.old-12345678-1234-4123-8123-1234567890ab");
    await fs.mkdir(parked, { recursive: true });
    await fs.writeFile(
      path.join(parked, "plugin.json"),
      JSON.stringify({ name: "acme.survivor", version: "1.0.0" })
    );

    const service = new PluginService(pluginsRoot, "0.0.0");
    await service.initialize();

    // The live dir is loaded (and survives); the parked copy never wins the
    // duplicate-name race and is reaped.
    const loaded = service.listPlugins().find((p) => p.manifest.name === "acme.survivor");
    expect(loaded).toBeDefined();
    expect(loaded?.dir).toBe(realDir);
    expect(loaded?.manifest.version).toBe("2.0.0");
    expect(await exists(realDir)).toBe(true);
    expect(await exists(parked)).toBe(false);

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

describe("installPlugin — name collision (#10518)", () => {
  // The installer's `existing` probe only sees the user plugins root. These tests
  // reach into the service's launch-time bookkeeping (the same `reservedNames` /
  // `disabledPlugins` the deps bag exposes) to simulate a built-in or reserved
  // name that has no user-root directory.
  type Internals = {
    reservedNames: Set<string>;
    disabledPlugins: Map<string, { manifest: unknown; dir: string; isBuiltin: boolean }>;
  };

  it("rejects installing over a built-in name with name_collision and writes no dir", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    (service as unknown as Internals).disabledPlugins.set("acme.builtin-clash", {
      manifest: { name: "acme.builtin-clash" },
      dir: "/builtin/acme.builtin-clash",
      isBuiltin: true,
    });

    const archive = await makeArchive({ name: "acme.builtin-clash", version: "1.0.0" });
    const result = await service.installPlugin(archive);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errors[0].code).toBe("name_collision");
    }
    expect(await exists(path.join(pluginsRoot, "acme.builtin-clash"))).toBe(false);
    // No temp/parked debris either — the guard returns before the swap.
    const entries = await fs.readdir(pluginsRoot).catch(() => [] as string[]);
    expect(entries.filter((e) => e.startsWith(".install-tmp-"))).toHaveLength(0);

    service.dispose();
  });

  it("rejects a fresh install whose id is a launch-reserved name", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    (service as unknown as Internals).reservedNames.add("acme.reserved-clash");

    const archive = await makeArchive({ name: "acme.reserved-clash", version: "1.0.0" });
    const result = await service.installPlugin(archive);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errors[0].code).toBe("name_collision");
    }
    expect(await exists(path.join(pluginsRoot, "acme.reserved-clash"))).toBe(false);

    service.dispose();
  });

  it("still allows upgrading a normal user plugin whose dir already exists", async () => {
    // A reserved name with an EXISTING dir is a legitimate upgrade, not a
    // collision — the guard only fires on `!existing`.
    const service = new PluginService(pluginsRoot, "0.0.0");

    const v1 = await makeArchive({ name: "acme.not-a-clash", version: "1.0.0" });
    expect((await service.installPlugin(v1)).status).toBe("installed");

    const v2 = await makeArchive({ name: "acme.not-a-clash", version: "2.0.0" });
    expect((await service.installPlugin(v2)).status).toBe("installed");

    service.dispose();
  });
});

describe("installPlugin — consent reset on upgrade (#10518)", () => {
  it("revokes the plugin's consent pins on upgrade but not on a fresh install", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");

    const v1 = await makeArchive({ name: "acme.consent-reset", version: "1.0.0" });
    expect((await service.installPlugin(v1)).status).toBe("installed");
    // A fresh install has no prior pins to inherit — nothing to revoke.
    expect(consentMock.revokeAllForPlugin).not.toHaveBeenCalled();

    consentMock.revokeAllForPlugin.mockClear();
    const v2 = await makeArchive({ name: "acme.consent-reset", version: "2.0.0" });
    expect((await service.installPlugin(v2)).status).toBe("installed");

    // Any code change forces a consent re-prompt: the upgrade purges the pins.
    expect(consentMock.revokeAllForPlugin).toHaveBeenCalledWith("acme.consent-reset");

    service.dispose();
  });

  it("revokes the plugin's consent pins on uninstall", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");

    const v1 = await makeArchive({ name: "acme.uninstall-consent", version: "1.0.0" });
    expect((await service.installPlugin(v1)).status).toBe("installed");

    consentMock.revokeAllForPlugin.mockClear();
    await service.uninstallPlugin("acme.uninstall-consent");

    // Uninstall is the other half of the consent-reset guarantee — a same-name
    // reinstall must not inherit the removed plugin's approvals.
    expect(consentMock.revokeAllForPlugin).toHaveBeenCalledWith("acme.uninstall-consent");

    service.dispose();
  });
});

describe("loadDevPlugin — trust gates (#10518)", () => {
  it.each(["../../etc/passwd", "..", "foo/../../bar", "/abs/path", "no-dot-name"])(
    "rejects a non-scoped / traversal dev plugin id %s before any fs access",
    async (badId) => {
      const service = new PluginService(pluginsRoot, "0.0.0");
      await expect(service.loadDevPlugin(badId)).rejects.toThrow(/Invalid dev plugin id|scoped/);
      service.dispose();
    }
  );

  it("honors the persisted disabled set instead of force-loading", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    // A dev plugin present on disk but disabled in Preferences must NOT load —
    // the old code passed an empty disabled set and would have force-loaded it.
    const devDir = path.join(pluginsRoot, "acme.dev-honor");
    await fs.mkdir(devDir, { recursive: true });
    await fs.writeFile(
      path.join(devDir, "plugin.json"),
      JSON.stringify({ name: "acme.dev-honor", version: "1.0.0" })
    );
    (
      service as unknown as { records: { setEnabled(id: string, enabled: boolean): void } }
    ).records.setEnabled("acme.dev-honor", false);

    await expect(service.loadDevPlugin("acme.dev-honor")).rejects.toThrow(/disabled|Couldn't load/);

    service.dispose();
  });
});
