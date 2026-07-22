// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { join } from "node:path";

const shellMock = vi.hoisted(() => ({
  openPath: vi.fn(async () => ""),
  showItemInFolder: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((key: string) => `/mock/electron/${key}`),
    getVersion: vi.fn(() => "0.15.0"),
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  webContents: { getAllWebContents: vi.fn(() => []) },
  clipboard: { writeText: vi.fn(), writeImage: vi.fn(), readText: vi.fn(() => "") },
  nativeImage: { createFromBuffer: vi.fn(() => ({ isEmpty: () => true })) },
  shell: shellMock,
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    getAllProjects: vi.fn(() => []),
    getCurrentProjectId: vi.fn(() => null),
  },
}));

const appendSpy = vi.fn();
vi.mock("../PluginActionAuditService.js", () => ({
  getPluginActionAuditService: () => ({ append: appendSpy }),
}));

import { PluginService } from "../PluginService.js";
import { _resetPluginCapabilityServicesForTest } from "../plugin-capability/instances.js";
import type { PluginManifest, PluginHostApi } from "../../../shared/types/plugin.js";

let svc: PluginService;
let baseDir: string;
let allowed: string;
let homeDir: string;
let homedirSpy: MockInstance<() => string>;

/** The implicit per-plugin data dir for the fixture plugin under the faked home. */
function dataDir(): string {
  return join(homeDir, ".daintree", "plugin-data", "acme.sys");
}

interface FakeLoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  loadedAt: number;
  isBuiltin: boolean;
}

function registerPlugin(capabilities: string[], allowedPaths: string[] = []): PluginHostApi {
  const seam = svc as unknown as {
    _registerFakePluginForTests(p: FakeLoadedPlugin): void;
    _createHostForTests(id: string): PluginHostApi;
  };
  seam._registerFakePluginForTests({
    manifest: {
      name: "acme.sys",
      version: "1.0.0",
      capabilities,
      scopes: { fs: { allowedPaths } },
      contributes: { fileDecorationProviders: [], forgeProviders: [] },
    } as unknown as PluginManifest,
    dir: baseDir,
    loadedAt: 0,
    isBuiltin: false,
  });
  return seam._createHostForTests("acme.sys");
}

/** Create a file inside the plugin's own data namespace and return its path. */
async function writeInDataDir(name: string): Promise<string> {
  await fs.mkdir(dataDir(), { recursive: true });
  const target = join(dataDir(), name);
  await fs.writeFile(target, "x");
  return target;
}

beforeEach(async () => {
  appendSpy.mockClear();
  shellMock.openPath.mockClear();
  shellMock.openPath.mockResolvedValue("");
  shellMock.showItemInFolder.mockClear();
  baseDir = mkdtempSync(join(tmpdir(), "plugin-sys-"));
  const pluginsRoot = join(baseDir, "plugins");
  mkdirSync(pluginsRoot, { recursive: true });
  allowed = join(baseDir, "allowed");
  await fs.mkdir(allowed, { recursive: true });
  // Redirect home into the fixture so the implicit plugin-data dir lands in
  // the temp tree rather than the real home.
  homeDir = join(baseDir, "home");
  await fs.mkdir(homeDir, { recursive: true });
  homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  svc = new PluginService(pluginsRoot);
});

afterEach(() => {
  homedirSpy.mockRestore();
  _resetPluginCapabilityServicesForTest();
  rmSync(baseDir, { recursive: true, force: true });
});

describe("host.system plugin-data namespace", () => {
  it("opens a file in the plugin's own data dir with no declared allowedPaths", async () => {
    // The gap the API exists to close: the renderer's system.openPath validates
    // against project/worktree/userData roots, none of which cover
    // ~/.daintree/plugin-data/<id>/, so a plugin could not reveal a file it
    // had just written there.
    const host = registerPlugin(["fs:user-data-write"]);
    const target = await writeInDataDir("shot.png");

    await expect(host.system.openPath(target)).resolves.toBeUndefined();
    expect(shellMock.openPath).toHaveBeenCalledTimes(1);
  });

  it("reveals a file in the plugin's own data dir", async () => {
    const host = registerPlugin(["fs:user-data-write"]);
    const target = await writeInDataDir("shot.png");

    await expect(host.system.showItemInFolder(target)).resolves.toBeUndefined();
    expect(shellMock.showItemInFolder).toHaveBeenCalledTimes(1);
  });

  it("hands the realpath-resolved target to the shell, not the raw input", async () => {
    // Containment resolves symlinks; passing the raw string to the sink would
    // reopen the TOCTOU window that resolution exists to shrink.
    const host = registerPlugin(["fs:user-data-write"]);
    const target = await writeInDataDir("shot.png");

    await host.system.openPath(target);
    const passed = shellMock.openPath.mock.calls[0][0] as unknown as string;
    expect(passed).toBe(await fs.realpath(target));
  });
});

describe("host.system capability gating", () => {
  it("accepts the read capability for the matched root class", async () => {
    const host = registerPlugin(["fs:user-data-read"]);
    const target = await writeInDataDir("a.txt");
    await expect(host.system.openPath(target)).resolves.toBeUndefined();
  });

  it("accepts the write capability for the matched root class", async () => {
    // A plugin that could legitimately create the file shouldn't also have to
    // declare read access just to show the user where it landed.
    const host = registerPlugin(["fs:user-data-write"]);
    const target = await writeInDataDir("a.txt");
    await expect(host.system.openPath(target)).resolves.toBeUndefined();
  });

  it("rejects when the plugin holds no fs capability for that root class", async () => {
    const host = registerPlugin(["clipboard:write"]);
    const target = await writeInDataDir("a.txt");
    await expect(host.system.openPath(target)).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("does not accept a project capability for a user-data path", async () => {
    // The class is resolved from the root that actually matched, so holding
    // project access cannot launder into the plugin-data namespace.
    const host = registerPlugin(["fs:project-read", "fs:project-write"]);
    const target = await writeInDataDir("a.txt");
    await expect(host.system.openPath(target)).rejects.toThrow(/PERMISSION_REQUIRED/);
  });

  it("gates showItemInFolder on the same capabilities as openPath", async () => {
    const host = registerPlugin(["clipboard:write"]);
    const target = await writeInDataDir("a.txt");
    await expect(host.system.showItemInFolder(target)).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });
});

describe("host.system containment", () => {
  it("rejects a path outside every declared root", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const outside = join(baseDir, "outside.txt");
    await fs.writeFile(outside, "x");

    await expect(host.system.openPath(outside)).rejects.toThrow();
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("rejects a traversal that escapes an allowed root", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const outside = join(baseDir, "outside.txt");
    await fs.writeFile(outside, "x");

    await expect(host.system.openPath(join(allowed, "..", "outside.txt"))).rejects.toThrow();
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("rejects a symlink inside an allowed root that points outside it", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const outside = join(baseDir, "secret.txt");
    await fs.writeFile(outside, "x");
    const link = join(allowed, "link.txt");
    await fs.symlink(outside, link);

    await expect(host.system.openPath(link)).rejects.toThrow();
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("rejects a relative path", async () => {
    const host = registerPlugin(["fs:user-data-read"]);
    await expect(host.system.openPath("relative/path.txt")).rejects.toThrow();
  });

  it("rejects a path that does not exist", async () => {
    // The plugin path resolver admits a non-existent final component so
    // fs.writeFile can create new files, which is wrong for these sinks —
    // hence an explicit existence gate.
    const host = registerPlugin(["fs:user-data-read"]);
    await fs.mkdir(dataDir(), { recursive: true });
    await expect(host.system.openPath(join(dataDir(), "missing.txt"))).rejects.toThrow(
      /INVALID_PATH/
    );
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("rejects revealing a path that does not exist rather than no-opping", async () => {
    // shell.showItemInFolder returns void and does nothing for a missing
    // path, so without the gate the plugin is told it succeeded while no
    // window opened — the failure mode with no visible symptom.
    const host = registerPlugin(["fs:user-data-read"]);
    await fs.mkdir(dataDir(), { recursive: true });
    await expect(host.system.showItemInFolder(join(dataDir(), "missing.txt"))).rejects.toThrow(
      /INVALID_PATH/
    );
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it("opens a file inside a declared allowedPaths root", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const target = join(allowed, "note.txt");
    await fs.writeFile(target, "x");

    await expect(host.system.openPath(target)).resolves.toBeUndefined();
  });
});

describe("host.system executable deny-list", () => {
  // The deny-list is selected per platform at module init, so pick an
  // extension the running platform actually denies.
  const deniedExt =
    process.platform === "win32" ? ".exe" : process.platform === "darwin" ? ".command" : ".sh";

  it("refuses to open an executable file type", async () => {
    const host = registerPlugin(["fs:user-data-write"]);
    const target = await writeInDataDir(`payload${deniedExt}`);

    await expect(host.system.openPath(target)).rejects.toThrow(/executable/i);
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("refuses an innocuously-named symlink resolving to an executable", async () => {
    // The realpath re-check is the whole point: the raw name passes the
    // deny-list, so without it the symlink is a launch primitive.
    const host = registerPlugin(["fs:user-data-write"]);
    const payload = await writeInDataDir(`payload${deniedExt}`);
    const link = join(dataDir(), "notes.txt");
    await fs.symlink(payload, link);

    await expect(host.system.openPath(link)).rejects.toThrow(/executable/i);
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("still reveals an executable — showing a file is not running it", async () => {
    const host = registerPlugin(["fs:user-data-write"]);
    const target = await writeInDataDir(`payload${deniedExt}`);

    await expect(host.system.showItemInFolder(target)).resolves.toBeUndefined();
    expect(shellMock.showItemInFolder).toHaveBeenCalledTimes(1);
  });
});

describe("host.system failure and liveness", () => {
  it("surfaces a shell.openPath failure instead of resolving silently", async () => {
    // shell.openPath reports failure by returning a non-empty string rather
    // than rejecting, so an unchecked call fails silently.
    shellMock.openPath.mockResolvedValue("No application knows how to open this file");
    const host = registerPlugin(["fs:user-data-write"]);
    const target = await writeInDataDir("a.txt");

    await expect(host.system.openPath(target)).rejects.toThrow(/No application knows/);
  });

  it("rejects with PLUGIN_UNLOADED after unload", async () => {
    const host = registerPlugin(["fs:user-data-write"]);
    const target = await writeInDataDir("a.txt");
    svc.unloadPlugin("acme.sys");

    await expect(host.system.openPath(target)).rejects.toThrow(/PLUGIN_UNLOADED/);
    await expect(host.system.showItemInFolder(target)).rejects.toThrow(/PLUGIN_UNLOADED/);
    expect(shellMock.openPath).not.toHaveBeenCalled();
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });
});

describe("host.system auditing", () => {
  it("audits a successful open", async () => {
    const host = registerPlugin(["fs:user-data-write"]);
    await host.system.openPath(await writeInDataDir("a.txt"));

    const audits = appendSpy.mock.calls.filter(
      (c) => (c[0] as { channel: string }).channel === "plugin:system-open-path"
    );
    expect(audits).toHaveLength(1);
  });

  it("audits a successful reveal", async () => {
    const host = registerPlugin(["fs:user-data-write"]);
    await host.system.showItemInFolder(await writeInDataDir("a.txt"));

    const audits = appendSpy.mock.calls.filter(
      (c) => (c[0] as { channel: string }).channel === "plugin:system-show-item"
    );
    expect(audits).toHaveLength(1);
  });

  it("does not audit a rejected call", async () => {
    const host = registerPlugin(["clipboard:write"]);
    await expect(host.system.openPath(await writeInDataDir("a.txt"))).rejects.toThrow();

    const audits = appendSpy.mock.calls.filter((c) =>
      (c[0] as { channel: string }).channel.startsWith("plugin:system-")
    );
    expect(audits).toHaveLength(0);
  });
});
