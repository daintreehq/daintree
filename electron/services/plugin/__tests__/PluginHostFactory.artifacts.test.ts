import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/daintree-test"), getVersion: vi.fn(() => "0.0.0") },
  clipboard: { readImage: vi.fn(), writeText: vi.fn(), readText: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
}));
vi.mock("../../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
  getProjectPushTargets: vi.fn(() => []),
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: vi.fn(() => null) }));
vi.mock("../../forgeProviderRegistry.js", () => ({
  registerForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpl: vi.fn(),
}));
vi.mock("../../fileDecorationRegistry.js", () => ({
  registerFileDecorationProviderImpl: vi.fn(),
  unregisterFileDecorationProviderImpl: vi.fn(),
  scopeMatchesPattern: vi.fn((scope: string, pattern: string) => scope === pattern),
}));
vi.mock("../../PluginActionAuditService.js", () => ({
  getPluginActionAuditService: vi.fn(() => ({ append: vi.fn(), getRecords: vi.fn(() => []) })),
}));
vi.mock("../../plugin-capability/instances.js", () => ({
  getPluginCapabilityConsentService: vi.fn(() => ({ ensureAllowed: vi.fn(async () => undefined) })),
  getPluginCapabilityConsentStore: vi.fn(() => ({ hasGrant: vi.fn(() => false) })),
}));
vi.mock("../../forge/forgeCredentialUtils.js", () => ({
  buildStoredCredentials: vi.fn(() => null),
}));

import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import { PluginTaskRegistry } from "../PluginTaskRegistry.js";
import { PluginArtifactService } from "../PluginArtifactService.js";
import { PluginArtifactStore } from "../PluginArtifactStore.js";
import {
  UNBOUND_PLUGIN_HOST_BINDING,
  type BuiltInPluginCapability,
  type PluginHostApi,
  type PluginHostBinding,
} from "../../../../shared/types/plugin.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "acme";
const PROJECT = "a".repeat(64);

let tmp: string;
let projectDir: string;
let outsideDir: string;
let service: PluginArtifactService;
let netFetch: ReturnType<typeof vi.fn>;

function makeHost(
  capabilities: BuiltInPluginCapability[],
  options: { binding?: PluginHostBinding; allowedUrls?: string[] } = {}
): { host: PluginHostApi; deps: PluginHostFactoryDeps } {
  const plugin = {
    isBuiltin: true,
    manifest: {
      name: PLUGIN_ID,
      displayName: "Acme",
      capabilities,
      scopes: options.allowedUrls ? { network: { allowedUrls: options.allowedUrls } } : undefined,
      contributes: { forgeProviders: [], fileDecorationProviders: [] },
    },
  } as unknown as LoadedPlugin;
  const deps = {
    plugins: new Map([[PLUGIN_ID, plugin]]),
    pluginEventCleanups: new Map(),
    pluginActions: new Map(),
    pluginActionHandlers: new Map(),
    pluginActionOwners: new Map(),
    actionValidators: new Map(),
    pluginBadges: new Map(),
    pluginPanelMenus: new Map(),
    pluginFsWatchers: new Map(),
    pluginTasks: new PluginTaskRegistry(() => {}),
    broadcaster: { schedulePluginActionsBroadcast: vi.fn() },
    panelLifecycleBroker: {
      subscribe: vi.fn(() => () => {}),
      locate: vi.fn(() => ({ kind: "missing" })),
    },
    dispatcher: {},
    promptDispatcher: {},
    settings: {},
    storage: {},
    getHostGitFactory: () => undefined,
    getProcessManager: vi.fn(),
    declaredCapabilities: () => new Set<string>(capabilities),
    recordPluginLog: vi.fn(),
    serializePluginBadges: () => ({}),
    serializePluginPanelMenus: () => ({}),
    pluginDisplayName: () => "Acme",
    pluginDataDir: () => path.join(tmp, "data"),
    isPathUnder: () => false,
    expandAllowedPathEntries: async () => [{ path: projectDir, rootClass: "project" }],
    artifactService: () => service,
    subscribeWorktreeEvent: vi.fn(() => () => {}),
    registerHandler: vi.fn(),
    validateAndBuildActionDescriptor: vi.fn(),
    safeAppendAudit: vi.fn(),
    safeArgsHash: () => "",
    pluginNotificationsBlocked: vi.fn(async () => false),
  } as unknown as PluginHostFactoryDeps;
  const { host } = createHost(deps, PLUGIN_ID, options.binding ?? UNBOUND_PLUGIN_HOST_BINDING);
  return { host, deps };
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "artifact-host-")));
  projectDir = path.join(tmp, "project");
  outsideDir = path.join(tmp, "outside");
  await fs.mkdir(projectDir);
  await fs.mkdir(outsideDir);
  await fs.writeFile(path.join(projectDir, "clip.mp4"), Buffer.alloc(4096, 1));
  await fs.writeFile(path.join(outsideDir, "secret.mp4"), "secret");
  netFetch = vi.fn();
  service = new PluginArtifactService({
    store: new PluginArtifactStore({ rootDir: path.join(tmp, "cache") }),
    netFetch: netFetch as never,
    sweepIntervalMs: 0,
  });
});

afterEach(async () => {
  await service.dispose();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("host.artifacts gates", () => {
  it("rejects every method without artifact:store, as a rejection rather than a throw", async () => {
    const { host } = makeHost(["fs:project-read", "network:fetch"]);
    const calls = [
      () => host.artifacts.import({ path: path.join(projectDir, "clip.mp4") }),
      () => host.artifacts.download({ url: "https://api.example.com/x" }),
      () => host.artifacts.upload("0".repeat(32), { url: "https://api.example.com/x" }),
      () => host.artifacts.stat("0".repeat(32)),
      () => host.artifacts.list(),
      () => host.artifacts.release("0".repeat(32)),
    ];
    for (const call of calls) {
      let pending: Promise<unknown> | undefined;
      expect(() => (pending = call())).not.toThrow();
      await expect(pending).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" });
    }
  });

  it("reports an unloaded plugin before its capabilities", async () => {
    const { host, deps } = makeHost(["artifact:store"]);
    deps.plugins.delete(PLUGIN_ID);
    await expect(host.artifacts.list()).rejects.toMatchObject({ code: "PLUGIN_UNLOADED" });
  });

  it("needs network:fetch for a transfer and holds the URL to the declared scope", async () => {
    const bare = makeHost(["artifact:store"], { allowedUrls: ["https://api.example.com/v1"] });
    await expect(
      bare.host.artifacts.download({ url: "https://api.example.com/v1/a" })
    ).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" });

    const { host } = makeHost(["artifact:store", "network:fetch"], {
      allowedUrls: ["https://api.example.com/v1"],
    });
    for (const url of [
      "https://api.example.com/v10/a",
      "https://api.example.com:8443/v1/a",
      "http://api.example.com/v1/a",
      "https://other.example.com/v1/a",
      "https://user:pw@api.example.com/v1/a",
    ]) {
      await expect(host.artifacts.download({ url })).rejects.toMatchObject({
        code: "ARTIFACT_URL_NOT_ALLOWED",
      });
    }
    expect(netFetch).not.toHaveBeenCalled();
  });

  it("refuses every transfer when the manifest declares no URLs", async () => {
    const { host } = makeHost(["artifact:store", "network:fetch"]);
    await expect(
      host.artifacts.download({ url: "https://api.example.com/v1/a" })
    ).rejects.toMatchObject({ code: "ARTIFACT_URL_NOT_ALLOWED" });
  });

  it("refuses headers the transfer owns and bad attempt counts", async () => {
    const { host } = makeHost(["artifact:store", "network:fetch"], {
      allowedUrls: ["https://api.example.com"],
    });
    const refused: Record<string, string>[] = [
      { Cookie: "a=1" },
      { Range: "bytes=0-" },
      { "x-ok": "a\r\nb" },
    ];
    for (const headers of refused) {
      await expect(
        host.artifacts.download({ url: "https://api.example.com/a", headers })
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await expect(
      host.artifacts.download({ url: "https://api.example.com/a" }, { attempts: 4 })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("keeps a project plugin's artifacts in its own project", async () => {
    const { host } = makeHost(["artifact:store", "fs:project-read"], {
      binding: { projectId: PROJECT, projectRoot: projectDir },
    });
    await expect(
      host.artifacts.import(
        { path: path.join(projectDir, "clip.mp4") },
        { projectId: "b".repeat(64) }
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const artifact = await host.artifacts.import({ path: path.join(projectDir, "clip.mp4") });
    expect(artifact.projectId).toBe(PROJECT);
    await expect(host.artifacts.list({ projectId: null })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("host.artifacts.import", () => {
  it("imports a scoped file and hands back a handle with no path in it", async () => {
    const { host } = makeHost(["artifact:store", "fs:project-read"]);
    const artifact = await host.artifacts.import({ path: path.join(projectDir, "clip.mp4") });
    expect(artifact).toMatchObject({ name: "clip.mp4", mimeType: "video/mp4", size: 4096 });
    expect(JSON.stringify(artifact)).not.toContain(projectDir);
    expect(await host.artifacts.stat(artifact.id)).toEqual(artifact);
    expect(await host.artifacts.release(artifact.id)).toBe(true);
    expect(await host.artifacts.stat(artifact.id)).toBeNull();
  });

  it("needs the read capability for the path's root", async () => {
    const { host } = makeHost(["artifact:store"]);
    await expect(
      host.artifacts.import({ path: path.join(projectDir, "clip.mp4") })
    ).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" });
  });

  it("refuses traversal out of scope and a symlink that leads out", async () => {
    const { host } = makeHost(["artifact:store", "fs:project-read"]);
    await expect(
      host.artifacts.import({ path: path.join(projectDir, "..", "outside", "secret.mp4") })
    ).rejects.toThrow();
    await fs.symlink(path.join(outsideDir, "secret.mp4"), path.join(projectDir, "link.mp4"));
    await expect(
      host.artifacts.import({ path: path.join(projectDir, "link.mp4") })
    ).rejects.toThrow();
    expect(await host.artifacts.list()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO without blocking on it", async () => {
    const fifo = path.join(projectDir, "pipe.mp4");
    execFileSync("mkfifo", [fifo]);
    const { host } = makeHost(["artifact:store", "fs:project-read"]);
    await expect(host.artifacts.import({ path: fifo })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  });

  it("refuses a directory", async () => {
    const { host } = makeHost(["artifact:store", "fs:project-read"]);
    await expect(host.artifacts.import({ path: projectDir })).rejects.toThrow();
  });

  it("validates ids before touching the cache", async () => {
    const { host } = makeHost(["artifact:store"]);
    await expect(host.artifacts.stat("../../etc")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(host.artifacts.release("Z".repeat(32))).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});
