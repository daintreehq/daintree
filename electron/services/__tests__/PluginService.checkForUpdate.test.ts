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
 * for every domain outcome and never throws. The fetch is the only mocked
 * collaborator; the real pack/hash/manifest-read logic runs unmocked.
 *
 * Mocks mirror `PluginService.install.test.ts`, plus the manual-redirect fetch
 * the download goes through, routed to `netMock.fetch`.
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
// Consent pins are purged when an upgrade actually swaps (#12612 binding tests);
// stubbed so those assertions don't stand up real consent persistence.
const consentMock = vi.hoisted(() => ({ revokeAllForPlugin: vi.fn(() => true) }));
const capConsentMock = vi.hoisted(() => ({
  revokeAllForPlugin: vi.fn(() => true),
  listGrantsForPlugin: vi.fn((): unknown[] => []),
  offerRestore: vi.fn(async () => false),
}));

vi.mock("electron", () => ({
  app: appMock,
  // Electron's own net.fetch rejects every manual-mode redirect (#16855), so a
  // download wired back to it fails here instead of reaching the scripted stub.
  net: {
    fetch: vi.fn(async () => {
      throw new Error("Redirect was cancelled");
    }),
  },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock("../../utils/netManualRedirectFetch.js", () => ({
  createManualRedirectFetch: () => (url: string, init?: RequestInit) => netMock.fetch(url, init),
}));
// The catalog client is real, fed by a fake catalog fetch per test, so a check
// reads the catalog the way it does in the app (#16781).
const catalogRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../plugin/PluginCatalogService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugin/PluginCatalogService.js")>();
  return { ...actual, getPluginCatalogService: () => catalogRef.current };
});
// Catalog releases live on github.com; resolve it without the network.
vi.mock("node:dns/promises", () => ({
  default: { lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) },
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

vi.mock("../plugin-mcp/instances.js", () => ({
  getPluginMcpConsentService: () => consentMock,
  getPluginMcpRateLimiter: () => ({ dropPlugin: vi.fn() }),
}));
vi.mock("../plugin-capability/instances.js", () => ({
  getPluginCapabilityConsentService: () => capConsentMock,
}));

import { createHash } from "crypto";
import { PluginService } from "../PluginService.js";
import { packPluginArchive } from "../PluginArchive.js";
// Namespace import so the binding tests can prove a refused archive is never
// extracted, not merely never swapped in.
import * as PluginArchive from "../PluginArchive.js";
import { MAX_DNTR_BYTES } from "../../utils/pluginArchiveConstants.js";
import { PluginCatalogService } from "../plugin/PluginCatalogService.js";

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
      // Real ReadableStream exposes cancel() on the stream itself (used by the
      // early-return cleanup paths before any reader is acquired).
      cancel: () => Promise.resolve(),
    },
    _cancel: cancel,
  };
}

/** A 3xx redirect response carrying a `Location` header (manual-follow path). */
function redirectResponse(location: string, status = 302) {
  return {
    ok: false,
    status,
    headers: {
      get: (k: string) => (k.toLowerCase() === "location" ? location : null),
    },
    body: { cancel: () => Promise.resolve() },
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
  const installed = (
    storeState.get("plugins") as { installed: Record<string, { archiveHash: string }> }
  ).installed[manifest.name];
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

  it("returns fetch-failed (no fetch) when the record has no baseline hash", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await installUrlPlugin(service, { name: "acme.nohash", version: "1.0.0" });
    // Corrupt the record so archiveHash is null.
    const plugins = storeState.get("plugins") as {
      installed: Record<string, { archiveHash: unknown }>;
    };
    plugins.installed["acme.nohash"].archiveHash = null;
    storeState.set("plugins", plugins);

    const result = await service.checkForUpdate("acme.nohash");

    expect(result.status).toBe("fetch-failed");
    expect(netMock.fetch).not.toHaveBeenCalled();
    service.dispose();
  });

  it.each([
    "http://127.0.0.1/plugin.dntr",
    "https://169.254.169.254/plugin.dntr",
    "https://192.168.0.42/plugin.dntr",
    "http://[::1]/plugin.dntr",
  ])("returns fetch-failed (no fetch) for a private/loopback originalUrl %s", async (url) => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await installUrlPlugin(service, { name: "acme.private", version: "1.0.0" }, url);

    const result = await service.checkForUpdate("acme.private");

    expect(result.status).toBe("fetch-failed");
    if (result.status === "fetch-failed") {
      expect(result.message).toContain("private or loopback");
    }
    expect(netMock.fetch).not.toHaveBeenCalled();
    service.dispose();
  });
});

describe("checkForUpdate — redirect SSRF guard", () => {
  it.each([
    "http://127.0.0.1/plugin.dntr",
    "https://169.254.169.254/plugin.dntr",
    "https://192.168.0.42/plugin.dntr",
    "http://[::1]/plugin.dntr",
  ])(
    "rejects a redirect to a private host %s after a public original URL",
    async (privateTarget) => {
      const service = new PluginService(pluginsRoot, "0.0.0");
      const manifest = { name: "acme.redir", version: "1.0.0" };
      await installUrlPlugin(service, manifest);
      // The public original URL passes the entry guard, then 302s to a private host.
      netMock.fetch.mockResolvedValueOnce(redirectResponse(privateTarget));

      const result = await service.checkForUpdate("acme.redir");

      expect(result.status).toBe("fetch-failed");
      if (result.status === "fetch-failed") {
        expect(result.message).toContain("private or loopback");
      }
      // The first hop was fetched; the private target never was.
      expect(netMock.fetch).toHaveBeenCalledTimes(1);
      expect(await leftoverTempDirs()).toHaveLength(0);
      service.dispose();
    }
  );

  it("follows a public→public redirect and compares the final archive", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const manifest = { name: "acme.redirok", version: "1.0.0" };
    await installUrlPlugin(service, manifest);
    const bytes = await readArchiveBytes(manifest);
    netMock.fetch
      .mockResolvedValueOnce(redirectResponse("https://cdn.example.net/plugin.dntr"))
      .mockResolvedValueOnce(fakeResponse([new Uint8Array(bytes)]));

    const result = await service.checkForUpdate("acme.redirok");

    expect(result).toEqual({ status: "up-to-date" });
    expect(netMock.fetch).toHaveBeenCalledTimes(2);
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
      permissionBypassAgents: [],
      // The digest of the bytes previewed, not the installed baseline — it is
      // what a confirmed update is later held to (#12612).
      archiveHash: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(await leftoverTempDirs()).toHaveLength(0);
    service.dispose();
  });

  it("names the new version's agents that can skip permission prompts (#16374)", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await installUrlPlugin(service, { name: "acme.agents", version: "1.0.0" });
    const agent = { command: "hermes", color: "#3366ff", iconId: "claude" };
    const bytes = await readArchiveBytes({
      name: "acme.agents",
      version: "2.0.0",
      capabilities: ["agent:register"],
      contributes: {
        agents: [
          { ...agent, id: "hermes", name: "Her\u202Emes", permissionBypassArgs: ["--yolo"] },
          { ...agent, id: "plain", name: "Plain" },
        ],
      },
    });
    netMock.fetch.mockResolvedValueOnce(fakeResponse([new Uint8Array(bytes)]));

    const result = await service.checkForUpdate("acme.agents");

    expect(result).toMatchObject({ status: "available", permissionBypassAgents: ["Hermes"] });
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

  it("returns fetch-failed for an unexpected content type with no .dntr suffix", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    // URL has no `.dntr` suffix, so the suffix fallback can't rescue the bad MIME.
    await installUrlPlugin(
      service,
      { name: "acme.html", version: "1.0.0" },
      "https://example.com/p"
    );
    netMock.fetch.mockResolvedValueOnce(
      fakeResponse([new Uint8Array([1, 2, 3])], { contentType: "text/html" })
    );

    const result = await service.checkForUpdate("acme.html");

    expect(result.status).toBe("fetch-failed");
    if (result.status === "fetch-failed") expect(result.message).toContain("text/html");
    service.dispose();
  });

  it("falls back to the .dntr URL suffix when the content type isn't a known archive type", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const manifest = { name: "acme.suffix", version: "1.0.0" };
    // Default install URL ends in `.dntr`; an unrecognised MIME is rescued by it.
    await installUrlPlugin(service, manifest);
    const bytes = await readArchiveBytes(manifest);
    netMock.fetch.mockResolvedValueOnce(
      fakeResponse([new Uint8Array(bytes)], { contentType: "text/html" })
    );

    const result = await service.checkForUpdate("acme.suffix");

    expect(result).toEqual({ status: "up-to-date" });
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

  it("returns fetch-failed when the archive is for a different plugin", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await installUrlPlugin(service, { name: "acme.victim", version: "1.0.0" });
    // A redirected/swapped URL now serves a completely different plugin.
    const bytes = await readArchiveBytes({ name: "evil.other", version: "9.9.9" });
    netMock.fetch.mockResolvedValueOnce(fakeResponse([new Uint8Array(bytes)]));

    const result = await service.checkForUpdate("acme.victim");

    expect(result.status).toBe("fetch-failed");
    if (result.status === "fetch-failed") expect(result.message).toContain("evil.other");
    expect(await leftoverTempDirs()).toHaveLength(0);
    service.dispose();
  });

  it("returns fetch-failed (not a thrown rejection) when the body read fails mid-stream", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await installUrlPlugin(service, { name: "acme.streamerr", version: "1.0.0" });
    let read = 0;
    netMock.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => "application/octet-stream" },
      body: {
        getReader: () => ({
          read: () =>
            read++ === 0
              ? Promise.resolve({ done: false, value: new Uint8Array([1, 2, 3]) })
              : Promise.reject(new Error("stream aborted")),
          cancel: () => Promise.resolve(),
        }),
      },
    });

    const result = await service.checkForUpdate("acme.streamerr");

    expect(result.status).toBe("fetch-failed");
    if (result.status === "fetch-failed") expect(result.message).toContain("stream aborted");
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

// #12612 regression: the confirm re-downloads the URL, so a server (or anyone on
// an http path) can answer the check with archive A and the install with B. The
// binding the preview hands back must stop every B variant from running or
// replacing anything, while the reviewed A still installs.
describe("checkForUpdate → install binding (#12612)", () => {
  const TARGET = "acme.target";
  const VICTIM = "acme.victim";
  const TARGET_URL = "https://example.com/target.dntr";

  /** Pack at a caller-named path: same-name/version variants must not collide. */
  async function packAs(
    label: string,
    manifest: ManifestShape,
    files: Record<string, string> = {}
  ): Promise<string> {
    const src = await fs.mkdtemp(path.join(tmpDir, "variant-"));
    await fs.writeFile(path.join(src, "plugin.json"), JSON.stringify(manifest));
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(src, rel)), { recursive: true });
      await fs.writeFile(path.join(src, rel), content);
    }
    const out = path.join(tmpDir, `${label}.dntr`);
    await packPluginArchive(src, out);
    return out;
  }

  const reviewedManifest = {
    name: TARGET,
    version: "2.0.0",
    capabilities: ["git:read"],
  };
  const reviewedFiles = { "dist/index.js": "module.exports = { reviewed: true };" };

  async function readManifestVersion(pluginId: string): Promise<string> {
    const raw = await fs.readFile(path.join(pluginsRoot, pluginId, "plugin.json"), "utf-8");
    return (JSON.parse(raw) as { version: string }).version;
  }

  function recordedHash(pluginId: string): string | undefined {
    return (storeState.get("plugins") as { installed: Record<string, { archiveHash: string }> })
      .installed[pluginId]?.archiveHash;
  }

  /** Install target + victim at v1, then preview the reviewed archive A. */
  async function reviewUpdate(service: PluginService) {
    await installUrlPlugin(service, { name: TARGET, version: "1.0.0" }, TARGET_URL);
    await installUrlPlugin(
      service,
      { name: VICTIM, version: "1.0.0" },
      "https://example.com/victim.dntr"
    );
    const reviewed = await packAs("reviewed-a", reviewedManifest, reviewedFiles);
    netMock.fetch.mockResolvedValueOnce(
      fakeResponse([new Uint8Array(await fs.readFile(reviewed))])
    );

    const result = await service.checkForUpdate(TARGET);
    if (result.status !== "available") throw new Error(`expected available, got ${result.status}`);
    // What confirmReinstall sends back: the installed plugin's id + the preview digest.
    return { reviewed, expected: { pluginId: TARGET, archiveHash: result.archiveHash } };
  }

  it.each([
    [
      "different payload bytes",
      () =>
        packAs("b-bytes", reviewedManifest, {
          "dist/index.js": "module.exports = { reviewed: false };",
        }),
    ],
    [
      "different capabilities",
      () =>
        packAs(
          "b-caps",
          { ...reviewedManifest, capabilities: ["git:read", "network:fetch"] },
          reviewedFiles
        ),
    ],
    [
      "a manifest.name naming another installed plugin",
      () => packAs("b-victim", { name: VICTIM, version: "2.0.0" }, reviewedFiles),
    ],
  ])("refuses a second download with %s", async (_label, makeSwapped) => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const { expected } = await reviewUpdate(service);
    const targetHash = recordedHash(TARGET);
    const victimHash = recordedHash(VICTIM);
    const swapped = await makeSwapped();
    const extractSpy = vi.spyOn(PluginArchive, "extractPluginArchive");
    consentMock.revokeAllForPlugin.mockClear();
    capConsentMock.revokeAllForPlugin.mockClear();

    try {
      const result = await service.installPlugin(swapped, {
        source: "url",
        originalUrl: TARGET_URL,
        expected,
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.errors[0]?.code).toBe("archive_mismatch");
      // Never unpacked, so nothing in it could run...
      expect(extractSpy).not.toHaveBeenCalled();
      // ...and nothing was replaced: both plugins keep their v1 dir and record,
      // and neither had its consent pins reset by an upgrade.
      expect(await readManifestVersion(TARGET)).toBe("1.0.0");
      expect(await readManifestVersion(VICTIM)).toBe("1.0.0");
      expect(recordedHash(TARGET)).toBe(targetHash);
      expect(recordedHash(VICTIM)).toBe(victimHash);
      expect(consentMock.revokeAllForPlugin).not.toHaveBeenCalled();
      expect(capConsentMock.revokeAllForPlugin).not.toHaveBeenCalled();
      const leftovers = (await fs.readdir(pluginsRoot)).filter(
        (e) => e.startsWith(".install-tmp-") || e.includes(".old-")
      );
      expect(leftovers).toHaveLength(0);
    } finally {
      extractSpy.mockRestore();
      service.dispose();
    }
  });

  it("installs the reviewed archive when the second download returns the same bytes", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const { reviewed, expected } = await reviewUpdate(service);

    const result = await service.installPlugin(reviewed, {
      source: "url",
      originalUrl: TARGET_URL,
      expected,
    });

    expect(result).toEqual({ status: "installed", pluginId: TARGET });
    expect(await readManifestVersion(TARGET)).toBe("2.0.0");
    expect(recordedHash(TARGET)).toBe(expected.archiveHash);
    expect(await readManifestVersion(VICTIM)).toBe("1.0.0");

    service.dispose();
  });
});

describe("checkForUpdate — catalog installs (#16781)", () => {
  const ID = "acme.session";
  const REPO = "https://github.com/acme/plugin-session";
  const OTHER_REPO = "https://github.com/someone-else/plugin-session";

  function releaseUrl(version: string, repo = REPO): string {
    return `${repo}/releases/download/v${version}/${ID}-${version}.dntr`;
  }

  function entry(version: string, sha256: string, repo = REPO) {
    return { id: ID, repo, version, url: releaseUrl(version, repo), sha256, capabilities: [] };
  }

  function sha(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  /**
   * The catalog answers each fetch with the next document, or fails: offline,
   * not published (404), or with a body that isn't a catalog.
   */
  function catalogServes(
    ...documents: Array<{ entries: unknown[] } | "offline" | "not-found" | "invalid">
  ) {
    const queue = [...documents];
    const fetchImpl = vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("unexpected catalog fetch");
      if (next === "offline") throw new TypeError("net::ERR_INTERNET_DISCONNECTED");
      if (next === "not-found") return new Response("Not Found", { status: 404 });
      return new Response(next === "invalid" ? "{ not json" : JSON.stringify(next), {
        headers: { "content-type": "application/json" },
      });
    });
    catalogRef.current = new PluginCatalogService({ cachePath: null, fetchImpl });
    return fetchImpl;
  }

  async function installFromCatalog(
    service: PluginService,
    version = "0.1.0",
    catalog: unknown = { id: ID, version, repo: REPO }
  ): Promise<string> {
    const archive = await makeArchive({ name: ID, version });
    const res = await service.installPlugin(archive, {
      source: "catalog",
      originalUrl: releaseUrl(version),
      catalog: catalog as { id: string; version: string; repo: string },
    });
    expect(res.status).toBe("installed");
    return sha(await fs.readFile(archive));
  }

  function installedRecord(pluginId: string): Record<string, unknown> | undefined {
    return (storeState.get("plugins") as { installed: Record<string, Record<string, unknown>> })
      .installed[pluginId];
  }

  it("offers 0.1.1 to an install of 0.1.0, downloading only the entry's URL", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const installedHash = await installFromCatalog(service);
    const next = await readArchiveBytes({
      name: ID,
      version: "0.1.1",
      displayName: "Session",
      capabilities: ["mcp:expose"],
    });
    catalogServes({ entries: [entry("0.1.0", installedHash), entry("0.1.1", sha(next))] });
    netMock.fetch.mockResolvedValueOnce(fakeResponse([new Uint8Array(next)]));
    const recordBefore = structuredClone(installedRecord(ID));

    const result = await service.checkForUpdate(ID);

    expect(result).toEqual({
      status: "available",
      name: ID,
      version: "0.1.1",
      displayName: "Session",
      capabilities: ["mcp:expose"],
      permissionBypassAgents: [],
      archiveHash: sha(next),
      catalog: { id: ID, version: "0.1.1", repo: REPO },
    });
    expect(netMock.fetch).toHaveBeenCalledTimes(1);
    expect(netMock.fetch.mock.calls[0]?.[0]).toBe(releaseUrl("0.1.1"));
    // A check installs nothing.
    expect(installedRecord(ID)).toEqual(recordBefore);
    expect(await leftoverTempDirs()).toHaveLength(0);
    service.dispose();
  });

  it("names the repository an update moved away from as a different source", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const installedHash = await installFromCatalog(service);
    const next = await readArchiveBytes({ name: ID, version: "0.1.1" });
    catalogServes({
      entries: [entry("0.1.0", installedHash), entry("0.1.1", sha(next), OTHER_REPO)],
    });
    netMock.fetch.mockResolvedValueOnce(fakeResponse([new Uint8Array(next)]));

    const result = await service.checkForUpdate(ID);

    expect(result).toMatchObject({
      status: "available",
      version: "0.1.1",
      catalog: { id: ID, version: "0.1.1", repo: OTHER_REPO },
      previousRepo: REPO,
    });
    expect(netMock.fetch.mock.calls[0]?.[0]).toBe(releaseUrl("0.1.1", OTHER_REPO));
    service.dispose();
  });

  it("says up to date while the installed release is the newest listed, downloading nothing", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const installedHash = await installFromCatalog(service);
    catalogServes({ entries: [entry("0.1.0", installedHash)] });

    expect(await service.checkForUpdate(ID)).toEqual({ status: "up-to-date" });
    expect(netMock.fetch).not.toHaveBeenCalled();
    service.dispose();
  });

  it("reports a delisted plugin as delisted and leaves the installed copy alone", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await installFromCatalog(service);
    catalogServes({ entries: [] });
    const recordBefore = structuredClone(installedRecord(ID));

    const result = await service.checkForUpdate(ID);

    expect(result).toEqual({ status: "delisted", scope: "plugin", version: "0.1.0" });
    expect(netMock.fetch).not.toHaveBeenCalled();
    expect(installedRecord(ID)).toEqual(recordBefore);
    expect(service.listPlugins().map((p) => p.manifest.name)).toContain(ID);
    service.dispose();
  });

  it("reports a delisted release when nothing newer replaced it", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await installFromCatalog(service, "0.1.1");
    catalogServes({ entries: [entry("0.1.0", "a".repeat(64))] });

    expect(await service.checkForUpdate(ID)).toEqual({
      status: "delisted",
      scope: "release",
      version: "0.1.1",
    });
    expect(netMock.fetch).not.toHaveBeenCalled();
    service.dispose();
  });

  it.each([
    ["offline", "unreachable"],
    ["not-found", "not-published"],
    ["invalid", "invalid"],
  ] as const)(
    "reports an unavailable catalog (%s) as such and offers nothing",
    async (served, failure) => {
      const service = new PluginService(pluginsRoot, "0.0.0");
      await installFromCatalog(service);
      catalogServes(served);

      expect(await service.checkForUpdate(ID)).toEqual({
        status: "catalog-unavailable",
        catalog: "unavailable",
        failure,
      });
      expect(netMock.fetch).not.toHaveBeenCalled();
      service.dispose();
    }
  );

  it.each([
    ["offline", "unreachable"],
    ["not-found", "not-published"],
  ] as const)(
    "reports a stale catalog (%s) when only an older copy is left, offering nothing from it",
    async (served, failure) => {
      const service = new PluginService(pluginsRoot, "0.0.0");
      const installedHash = await installFromCatalog(service);
      const next = await readArchiveBytes({ name: ID, version: "0.1.1" });
      const listing = { entries: [entry("0.1.0", installedHash), entry("0.1.1", sha(next))] };
      catalogServes(listing, served);
      netMock.fetch.mockResolvedValueOnce(fakeResponse([new Uint8Array(next)]));
      expect(await service.checkForUpdate(ID)).toMatchObject({ status: "available" });

      // The cached copy still lists 0.1.1, but an update never reads a cache.
      expect(await service.checkForUpdate(ID)).toEqual({
        status: "catalog-unavailable",
        catalog: "stale",
        failure,
      });
      expect(netMock.fetch).toHaveBeenCalledTimes(1);
      service.dispose();
    }
  );

  it("refuses bytes that aren't the entry's digest, before reading their manifest", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const installedHash = await installFromCatalog(service);
    const next = await readArchiveBytes({ name: ID, version: "0.1.1" });
    catalogServes({ entries: [entry("0.1.0", installedHash), entry("0.1.1", "f".repeat(64))] });
    netMock.fetch.mockResolvedValueOnce(fakeResponse([new Uint8Array(next)]));
    const readSpy = vi.spyOn(PluginArchive, "readArchiveManifest");

    const result = await service.checkForUpdate(ID);

    expect(result.status).toBe("fetch-failed");
    if (result.status === "fetch-failed") {
      expect(result.message).toContain("isn't the one the plugin catalog reviewed");
    }
    expect(readSpy).not.toHaveBeenCalled();
    expect(await leftoverTempDirs()).toHaveLength(0);
    readSpy.mockRestore();
    service.dispose();
  });

  it("refuses an archive for another plugin, even at the entry's version and digest", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const installedHash = await installFromCatalog(service);
    const stranger = await readArchiveBytes({ name: "acme.stranger", version: "0.1.1" });
    catalogServes({ entries: [entry("0.1.0", installedHash), entry("0.1.1", sha(stranger))] });
    netMock.fetch.mockResolvedValueOnce(fakeResponse([new Uint8Array(stranger)]));

    const result = await service.checkForUpdate(ID);

    expect(result.status).toBe("fetch-failed");
    if (result.status === "fetch-failed") {
      expect(result.message).toContain("isn't the release it names");
    }
    service.dispose();
  });

  it("refuses an archive that names another version than its entry", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const installedHash = await installFromCatalog(service);
    const wrong = await readArchiveBytes({ name: ID, version: "0.1.2" });
    catalogServes({ entries: [entry("0.1.0", installedHash), entry("0.1.1", sha(wrong))] });
    netMock.fetch.mockResolvedValueOnce(fakeResponse([new Uint8Array(wrong)]));

    const result = await service.checkForUpdate(ID);

    expect(result.status).toBe("fetch-failed");
    if (result.status === "fetch-failed") {
      expect(result.message).toContain("isn't the release it names");
    }
    service.dispose();
  });

  it.each([
    ["missing", undefined],
    ["for another plugin", { id: "acme.other", version: "0.1.0", repo: REPO }],
    ["with a malformed version", { id: ID, version: "latest", repo: REPO }],
    // Canonical in spelling, but beyond what semver can compare.
    ["with an uncomparable version", { id: ID, version: "9007199254740992.0.0", repo: REPO }],
  ])(
    "fails closed on provenance %s, never falling back to the install URL",
    async (_label, catalog) => {
      const service = new PluginService(pluginsRoot, "0.0.0");
      await installFromCatalog(service, "0.1.0", catalog);
      const plugins = storeState.get("plugins") as {
        installed: Record<string, Record<string, unknown>>;
      };
      // An install without provenance records `null`; simulate a record that
      // carries the given shape instead.
      plugins.installed[ID].catalog = catalog ?? null;
      const catalogFetch = catalogServes({ entries: [] });

      const result = await service.checkForUpdate(ID);

      expect(result.status).toBe("fetch-failed");
      expect(catalogFetch).not.toHaveBeenCalled();
      expect(netMock.fetch).not.toHaveBeenCalled();
      service.dispose();
    }
  );

  it("keeps checking a URL install against its URL, never the catalog", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const manifest = { name: "acme.byurl", version: "1.0.0" };
    await installUrlPlugin(service, manifest);
    const catalogFetch = catalogServes({ entries: [] });
    netMock.fetch.mockResolvedValueOnce(
      fakeResponse([new Uint8Array(await readArchiveBytes(manifest))])
    );

    expect(await service.checkForUpdate("acme.byurl")).toEqual({ status: "up-to-date" });
    expect(catalogFetch).not.toHaveBeenCalled();
    service.dispose();
  });
});
