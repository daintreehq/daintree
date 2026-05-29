import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

/**
 * Unit test for the manual update check (#9297).
 *
 * `PluginService.checkForUpdate` re-fetches the plugin's `originalUrl`, streams
 * the archive to a temp file (capped at `MAX_DNTR_BYTES`), hashes it, and
 * compares against the installed `archiveHash`. It returns a structured result
 * for every domain outcome and never throws. `net.fetch` is the only mocked
 * collaborator; the real pack/hash/manifest-read logic runs unmocked.
 *
 * Mocks mirror `PluginService.install.test.ts`, plus `net` on the electron mock
 * (the service lazy-imports it via `await import("electron")`).
 */

const appMock = vi.hoisted(() => ({
  getVersion: vi.fn(() => "0.0.0"),
  getPath: vi.fn(() => "/tmp/daintree-update-test-userdata"),
}));
const netMock = vi.hoisted(() => ({ fetch: vi.fn() }));
const storeMock = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => state.get(key)),
    set: vi.fn((key: string, value: unknown) => state.set(key, value)),
    _state: state,
  };
});

vi.mock("electron", () => ({
  app: appMock,
  net: netMock,
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
}));
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

import { PluginService } from "../PluginService.js";
import { packPluginArchive, MAX_DNTR_BYTES } from "../PluginArchive.js";

const storeState = storeMock._state;

let tmpDir: string;
let pluginsRoot: string;

interface ManifestShape {
  name: string;
  version: string;
  [key: string]: unknown;
}

async function makeArchive(manifest: ManifestShape): Promise<string> {
  const src = await fs.mkdtemp(path.join(tmpDir, "src-"));
  await fs.writeFile(path.join(src, "plugin.json"), JSON.stringify(manifest));
  const out = path.join(tmpDir, `${manifest.name}-${manifest.version}.dntr`);
  await packPluginArchive(src, out);
  return out;
}

/** Minimal `Response`-like object that streams `chunks` from `body.getReader()`. */
function fakeResponse(
  chunks: Uint8Array[],
  opts: { ok?: boolean; status?: number; contentType?: string | null } = {}
) {
  const { ok = true, status = 200, contentType = "application/octet-stream" } = opts;
  let i = 0;
  const cancel = vi.fn(() => Promise.resolve());
  return {
    ok,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
    body: {
      getReader: () => ({
        read: () =>
          i < chunks.length
            ? Promise.resolve({ done: false, value: chunks[i++] })
            : Promise.resolve({ done: true, value: undefined }),
        cancel,
      }),
    },
    _cancel: cancel,
  };
}

/** Install a URL-sourced plugin and return its recorded archive hash. */
async function installUrlPlugin(
  service: PluginService,
  manifest: ManifestShape,
  url = "https://example.com/plugin.dntr"
): Promise<string> {
  const archive = await makeArchive(manifest);
  const res = await service.installPlugin(archive, { source: "url", originalUrl: url });
  expect(res.status).toBe("installed");
  const installed = (storeState.get("plugins") as { installed: Record<string, { archiveHash: string }> })
    .installed[manifest.name];
  return installed.archiveHash;
}

async function readArchiveBytes(manifest: ManifestShape): Promise<Buffer> {
  const archive = await makeArchive(manifest);
  return fs.readFile(archive);
}

async function leftoverTempDirs(): Promise<string[]> {
  const entries = await fs.readdir(pluginsRoot);
  return entries.filter((e) => e.startsWith(".update-check-"));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-update-test-"));
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

describe("checkForUpdate — guards", () => {
  it("returns invalid-id for an unknown plugin and never fetches", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const result = await service.checkForUpdate("acme.nope");
    expect(result).toEqual({ status: "invalid-id" });
    expect(netMock.fetch).not.toHaveBeenCalled();
    service.dispose();
  });

  it("returns invalid-id for an empty pluginId", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    expect(await service.checkForUpdate("")).toEqual({ status: "invalid-id" });
    service.dispose();
  });

  it("returns invalid-id for a plugin without an originalUrl", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const archive = await makeArchive({ name: "acme.sideload", version: "1.0.0" });
    await service.installPlugin(archive); // sideload — no originalUrl
    const result = await service.checkForUpdate("acme.sideload");
    expect(result).toEqual({ status: "invalid-id" });
    expect(netMock.fetch).not.toHaveBeenCalled();
    service.dispose();
  });
});

describe("checkForUpdate — hash comparison", () => {
  it("returns up-to-date when the re-fetched archive hashes identically", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const manifest = { name: "acme.same", version: "1.0.0" };
    await installUrlPlugin(service, manifest);
    const bytes = await readArchiveBytes(manifest);
    netMock.fetch.mockResolvedValueOnce(fakeResponse([new Uint8Array(bytes)]));

    const result = await service.checkForUpdate("acme.same");

    expect(result).toEqual({ status: "up-to-date" });
    expect(await leftoverTempDirs()).toHaveLength(0);
    service.dispose();
  });

  it("returns available with the new manifest preview when hashes differ", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await installUrlPlugin(service, { name: "acme.diff", version: "1.0.0" });
    const newManifest = {
      name: "acme.diff",
      version: "2.0.0",
      displayName: "Acme Diff Pro",
      capabilities: ["network:fetch", "git:read"],
    };
    const bytes = await readArchiveBytes(newManifest);
    netMock.fetch.mockResolvedValueOnce(fakeResponse([new Uint8Array(bytes)]));

    const result = await service.checkForUpdate("acme.diff");

    expect(result).toEqual({
      status: "available",
      name: "acme.diff",
      version: "2.0.0",
      displayName: "Acme Diff Pro",
      capabilities: ["network:fetch", "git:read"],
    });
    expect(await leftoverTempDirs()).toHaveLength(0);
    service.dispose();
  });

  it("defaults capabilities to an empty array when the new manifest declares none", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await installUrlPlugin(service, { name: "acme.nocaps", version: "1.0.0" });
    const bytes = await readArchiveBytes({ name: "acme.nocaps", version: "2.0.0" });
    netMock.fetch.mockResolvedValueOnce(fakeResponse([new Uint8Array(bytes)]));

    const result = await service.checkForUpdate("acme.nocaps");

    expect(result).toMatchObject({ status: "available", version: "2.0.0", capabilities: [] });
    service.dispose();
  });
});

describe("checkForUpdate — fetch failures", () => {
  it("returns fetch-failed when the network request rejects", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await installUrlPlugin(service, { name: "acme.neterr", version: "1.0.0" });
    netMock.fetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await service.checkForUpdate("acme.neterr");

    expect(result.status).toBe("fetch-failed");
    if (result.status === "fetch-failed") expect(result.message).toContain("ECONNREFUSED");
    expect(await leftoverTempDirs()).toHaveLength(0);
    service.dispose();
  });

  it("returns fetch-failed on a non-2xx response", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await installUrlPlugin(service, { name: "acme.404", version: "1.0.0" });
    netMock.fetch.mockResolvedValueOnce(fakeResponse([], { ok: false, status: 404 }));

    const result = await service.checkForUpdate("acme.404");

    expect(result.status).toBe("fetch-failed");
    if (result.status === "fetch-failed") expect(result.message).toContain("404");
    service.dispose();
  });

  it("returns fetch-failed for an unexpected content type", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await installUrlPlugin(service, { name: "acme.html", version: "1.0.0" });
    netMock.fetch.mockResolvedValueOnce(
      fakeResponse([new Uint8Array([1, 2, 3])], { contentType: "text/html" })
    );

    const result = await service.checkForUpdate("acme.html");

    expect(result.status).toBe("fetch-failed");
    if (result.status === "fetch-failed") expect(result.message).toContain("text/html");
    service.dispose();
  });

  it("aborts and returns fetch-failed when the body exceeds the size cap", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await installUrlPlugin(service, { name: "acme.huge", version: "1.0.0" });
    // First chunk fills the cap exactly (written, not yet over); the 1-byte
    // second chunk pushes it over, triggering the abort.
    const response = fakeResponse([new Uint8Array(MAX_DNTR_BYTES), new Uint8Array([0])]);
    netMock.fetch.mockResolvedValueOnce(response);

    const result = await service.checkForUpdate("acme.huge");

    expect(result.status).toBe("fetch-failed");
    if (result.status === "fetch-failed") expect(result.message).toContain("size limit");
    expect(response._cancel).toHaveBeenCalled();
    expect(await leftoverTempDirs()).toHaveLength(0);
    service.dispose();
  });

  it("returns fetch-failed when the downloaded bytes aren't a valid archive", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await installUrlPlugin(service, { name: "acme.garbage", version: "1.0.0" });
    // Hashes differ from the installed archive, so it proceeds to manifest read,
    // which fails on non-zip bytes.
    netMock.fetch.mockResolvedValueOnce(
      fakeResponse([new Uint8Array(Buffer.from("not a zip archive"))])
    );

    const result = await service.checkForUpdate("acme.garbage");

    expect(result.status).toBe("fetch-failed");
    expect(await leftoverTempDirs()).toHaveLength(0);
    service.dispose();
  });
});
