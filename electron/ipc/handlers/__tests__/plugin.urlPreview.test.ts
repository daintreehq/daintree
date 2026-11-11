import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";

/**
 * A URL install's review and its confirm (#16776), end to end against real
 * `.dntr` archives, real hashing and the real installer. Only the network,
 * DNS, and the module-scope singletons `PluginService` imports are stubbed, so
 * what the review shows, what the confirm installs, and what is refused are
 * the production paths.
 */

const tmpState = vi.hoisted(() => ({ downloads: "" }));
const netFetch = vi.hoisted(() => vi.fn());
const appMock = vi.hoisted(() => ({
  getVersion: vi.fn(() => "0.0.0"),
  getPath: vi.fn(() => "/tmp/daintree-url-preview-test-userdata"),
}));
const storeMock = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => state.get(key)),
    set: vi.fn((key: string, value: unknown) => state.set(key, value)),
    _state: state,
  };
});
const consentMock = vi.hoisted(() => ({ revokeAllForPlugin: vi.fn(() => true) }));
const capConsentMock = vi.hoisted(() => ({
  revokeAllForPlugin: vi.fn(() => true),
  listGrantsForPlugin: vi.fn((): unknown[] => []),
  offerRestore: vi.fn(async () => false),
}));
const rateLimiterMock = vi.hoisted(() => ({ dropPlugin: vi.fn() }));
// The catalog client is exercised in its own suite; here it answers whatever
// each case says the freshly fetched catalog holds.
const catalogMock = vi.hoisted(() => ({ lookup: vi.fn() }));
const serviceRef = vi.hoisted(() => ({
  current: null as unknown,
  // Holds the next service lookup, which is where the preview's probe starts.
  gate: null as Promise<void> | null,
  lookups: 0,
}));

// Downloads land in this test's own directory, so "the download was removed"
// is a check on an empty folder rather than a scan of the shared temp dir.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const tmpdir = () => tmpState.downloads || actual.tmpdir();
  return { ...actual, default: { ...actual, tmpdir }, tmpdir };
});
vi.mock("node:dns/promises", () => ({
  default: { lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) },
}));
vi.mock("electron", () => ({
  app: appMock,
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  // Electron's own net.fetch rejects every manual-mode redirect (#16855), so a
  // download wired back to it fails here instead of reaching the scripted stub.
  net: {
    fetch: vi.fn(async () => {
      throw new Error("Redirect was cancelled");
    }),
  },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn() },
}));
// URL downloads fetch through the manual-redirect adapter over `net.request`;
// route it to the stub so each case still scripts every hop.
vi.mock("../../../utils/netManualRedirectFetch.js", () => ({
  createManualRedirectFetch: () => (url: string, init?: RequestInit) => netFetch(url, init),
}));
vi.mock("../../../window/windowRef.js", () => ({
  getWindowRegistry: vi.fn(() => null),
  getProjectViewManager: vi.fn(() => null),
  setWindowRegistry: vi.fn(),
  setMainWindow: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setProjectViewManager: vi.fn(),
}));
vi.mock("../../utils.js", () => ({ broadcastToRenderer: vi.fn(), sendToRendererContext: vi.fn() }));
vi.mock("../../../store.js", () => ({ store: storeMock }));
vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getCurrentProject: vi.fn(() => null) },
}));
vi.mock("../../../../shared/config/panelKindRegistry.js", () => ({
  registerPanelKind: vi.fn(),
  unregisterPluginPanelKinds: vi.fn(),
  onPanelKindRegistered: vi.fn(() => () => {}),
  onPanelKindUnregistered: vi.fn(() => () => {}),
  getPluginPanelKinds: vi.fn(() => []),
}));
vi.mock("../../../../shared/config/toolbarButtonRegistry.js", () => ({
  registerToolbarButton: vi.fn(),
  unregisterPluginToolbarButtons: vi.fn(),
  getAllPluginToolbarButtonConfigs: vi.fn(() => []),
}));
vi.mock("../../../services/pluginMenuRegistry.js", () => ({
  registerPluginMenuItem: vi.fn(),
  unregisterPluginMenuItems: vi.fn(),
  getPluginMenuItems: vi.fn(() => []),
}));
vi.mock("../../../services/forgeProviderRegistry.js", () => ({
  registerForgeProviders: vi.fn(),
  unregisterForgeProviders: vi.fn(),
  registerForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpls: vi.fn(),
  getForgeProviderImpl: vi.fn(),
  clearForgeProviderImplRegistry: vi.fn(),
}));
vi.mock("../../../services/fileDecorationRegistry.js", () => ({
  registerFileDecorationProviders: vi.fn(),
  registerFileDecorationProviderImpl: vi.fn(),
  unregisterFileDecorationProviders: vi.fn(),
  unregisterFileDecorationProviderImpls: vi.fn(),
  unregisterFileDecorationProviderImpl: vi.fn(),
  scopeMatchesPattern: vi.fn((s: string, p: string) => s === p),
}));
vi.mock("../../../services/PluginMcpSupervisor.js", () => ({
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
vi.mock("../../../services/plugin-mcp/instances.js", () => ({
  getPluginMcpConsentService: () => consentMock,
  getPluginMcpRateLimiter: () => rateLimiterMock,
}));
vi.mock("../../../services/plugin/PluginCatalogService.js", () => ({
  getPluginCatalogService: () => catalogMock,
}));
vi.mock("../../../services/plugin-capability/instances.js", () => ({
  getPluginCapabilityConsentService: () => capConsentMock,
}));
// A fresh service never runs the startup scan, so its catalog gate is opened
// here; every install still goes through the real installer.
vi.mock("../plugin/service.js", () => ({
  getPluginService: async () => {
    serviceRef.lookups += 1;
    if (serviceRef.gate) await serviceRef.gate;
    const service = serviceRef.current as PluginService;
    return {
      waitForCatalog: async () => {},
      getPluginsRoot: () => service.getPluginsRoot(),
      installPlugin: (...args: Parameters<PluginService["installPlugin"]>) =>
        service.installPlugin(...args),
    };
  },
}));

import { PluginService } from "../../../services/PluginService.js";
import * as PluginArchive from "../../../services/PluginArchive.js";
import { pluginInstallJobs } from "../../../services/plugin/PluginInstallJobRegistry.js";
import {
  handleCancelInstall,
  handleInstall,
  handleInstallFromCatalog,
  handleInstallFromCatalogOp,
  handleInstallFromUrl,
  handlePreviewFromCatalog,
  handlePreviewFromCatalogOp,
  handlePreviewFromUrl,
} from "../plugin/install.js";
import type {
  InstalledPluginRecord,
  PluginInstallExpectation,
  PluginInstallResult,
  PluginUrlInstallPreview,
  PluginUrlInstallPreviewResult,
} from "../../../../shared/types/plugin.js";

const URL = "https://example.com/acme.dntr";

let root: string;
let pluginsRoot: string;
let service: PluginService;

async function makeArchive(
  manifest: Record<string, unknown>,
  files: Record<string, string> = {}
): Promise<string> {
  const src = await fs.mkdtemp(path.join(root, "src-"));
  await fs.writeFile(path.join(src, "plugin.json"), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(src, rel)), { recursive: true });
    await fs.writeFile(path.join(src, rel), content);
  }
  const out = path.join(root, `${String(manifest.name)}-${crypto.randomUUID()}.dntr`);
  await PluginArchive.packPluginArchive(src, out);
  return out;
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

/** A zip whose only entry is `name`, so the manifest reader refuses it by name. */
async function zipWithEntry(name: string): Promise<string> {
  const out = path.join(root, `entry-${crypto.randomUUID()}.dntr`);
  const { ZipArchive } = await import("archiver");
  const zip = new ZipArchive({ zlib: { level: 1 } });
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(out);
    stream.on("close", resolve);
    stream.on("error", reject);
    zip.on("error", reject);
    zip.pipe(stream);
    zip.append("x", { name });
    void zip.finalize();
  });
  return out;
}

/** A response whose body is the archive's bytes, as the server would send it. */
async function serve(archive: string) {
  const bytes = new Uint8Array(await fs.readFile(archive));
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === "content-type" ? "application/zip" : null) },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

/** The server answers each request with the next archive, in order. */
function servesInOrder(...archives: string[]) {
  const queue = [...archives];
  netFetch.mockImplementation(async () => serve(queue.shift()!));
}

async function downloadsLeft(): Promise<string[]> {
  return fs.readdir(tmpState.downloads);
}

async function installedDir(pluginId: string): Promise<boolean> {
  return fs.access(path.join(pluginsRoot, pluginId)).then(
    () => true,
    () => false
  );
}

function recordedHash(pluginId: string): string | null | undefined {
  const plugins = storeMock._state.get("plugins") as
    { installed: Record<string, { archiveHash: string | null }> } | undefined;
  return plugins?.installed[pluginId]?.archiveHash;
}

async function review(url = URL): Promise<PluginUrlInstallPreview> {
  const result = await handlePreviewFromUrl(url);
  if (result.status !== "preview") throw new Error(`no preview: ${JSON.stringify(result)}`);
  return result.preview;
}

/** What the plugin manager sends when the user approves the review. */
function approval(preview: PluginUrlInstallPreview, replaces: boolean): PluginInstallExpectation {
  return {
    kind: replaces ? "update" : "install",
    pluginId: preview.manifest.name,
    archiveHash: preview.archiveHash,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "daintree-url-preview-"));
  pluginsRoot = path.join(root, "plugins");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(downloads);
  tmpState.downloads = downloads;
  service = new PluginService(pluginsRoot, "0.0.0");
  serviceRef.current = service;
  serviceRef.gate = null;
  serviceRef.lookups = 0;
  netFetch.mockReset();
});

afterEach(async () => {
  service.dispose();
  tmpState.downloads = "";
  storeMock._state.clear();
  vi.clearAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("a URL install's review (#16776)", () => {
  it("shows the downloaded archive's identity, capabilities and digest, installing nothing", async () => {
    const archive = await makeArchive({
      name: "acme.reviewed",
      version: "1.0.0",
      displayName: "Reviewed \u202Eevil",
      capabilities: ["shell:exec"],
      authors: [{ name: "Jordan Reyes", role: "maintainer" }],
    });
    servesInOrder(archive);

    const preview = await review(`  ${URL}  `);

    expect(preview.url).toBe(URL);
    expect(preview.archiveHash).toBe(await sha256(archive));
    expect(preview.installedOnDisk).toBe(false);
    expect(preview.manifest).toMatchObject({
      name: "acme.reviewed",
      version: "1.0.0",
      // The same sanitising as an archive opened from the operating system.
      displayName: "Reviewed evil",
      capabilities: ["shell:exec"],
      authors: [{ name: "Jordan Reyes", role: "maintainer" }],
      recipes: { count: 0, names: [] },
      projectTemplates: [],
      permissionBypassAgents: [],
    });
    expect(await installedDir("acme.reviewed")).toBe(false);
    expect(recordedHash("acme.reviewed")).toBeUndefined();
    expect(await downloadsLeft()).toEqual([]);
  });

  it("installs exactly the reviewed archive when confirmed", async () => {
    const archive = await makeArchive(
      { name: "acme.confirmed", version: "1.0.0" },
      { "dist/index.js": "module.exports = {};" }
    );
    servesInOrder(archive, archive);
    const preview = await review();

    const result = await handleInstallFromUrl(preview.url, undefined, approval(preview, false));

    expect(result).toEqual({ status: "installed", pluginId: "acme.confirmed" });
    expect(recordedHash("acme.confirmed")).toBe(preview.archiveHash);
    expect(await installedDir("acme.confirmed")).toBe(true);
    expect(await downloadsLeft()).toEqual([]);
  });

  it("leaves nothing installed and no download behind when the review is cancelled", async () => {
    const archive = await makeArchive({ name: "acme.declined", version: "1.0.0" });
    servesInOrder(archive);

    await review();

    // Cancel sends nothing to main: the review's download is already gone.
    expect(netFetch).toHaveBeenCalledTimes(1);
    expect(await installedDir("acme.declined")).toBe(false);
    expect(await downloadsLeft()).toEqual([]);
  });

  it("refuses different bytes at install time, and never installs them unbound", async () => {
    const reviewed = await makeArchive({ name: "acme.swapped", version: "1.0.0" }, { "a.js": "1" });
    const swapped = await makeArchive({ name: "acme.swapped", version: "1.0.0" }, { "a.js": "2" });
    servesInOrder(reviewed, swapped);
    const preview = await review();
    const extract = vi.spyOn(PluginArchive, "extractPluginArchive");

    try {
      const result = await handleInstallFromUrl(preview.url, undefined, approval(preview, false));

      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.errors[0]?.code).toBe("archive_mismatch");
      expect(extract).not.toHaveBeenCalled();
      expect(await installedDir("acme.swapped")).toBe(false);
      expect(recordedHash("acme.swapped")).toBeUndefined();
      expect(netFetch).toHaveBeenCalledTimes(2);
      expect(await downloadsLeft()).toEqual([]);
    } finally {
      extract.mockRestore();
    }
  });

  it("refuses a fresh-install approval for a plugin installed since the review", async () => {
    const v1 = await makeArchive({ name: "acme.raced", version: "1.0.0" }, { "v1.txt": "1" });
    const v2 = await makeArchive({ name: "acme.raced", version: "2.0.0" }, { "v2.txt": "2" });
    servesInOrder(v2, v2);
    const preview = await review();
    // Another window installs the plugin while this review is open.
    expect((await service.installPlugin(v1)).status).toBe("installed");

    const result = await handleInstallFromUrl(preview.url, undefined, approval(preview, false));

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.errors[0]?.code).toBe("archive_mismatch");
    expect(await fs.readFile(path.join(pluginsRoot, "acme.raced", "v1.txt"), "utf8")).toBe("1");
  });

  it("replaces the installed plugin when the review said it would", async () => {
    const v1 = await makeArchive({ name: "acme.upgraded", version: "1.0.0" }, { "v1.txt": "1" });
    const v2 = await makeArchive({ name: "acme.upgraded", version: "2.0.0" }, { "v2.txt": "2" });
    expect((await service.installPlugin(v1)).status).toBe("installed");
    servesInOrder(v2, v2);
    const preview = await review();
    expect(preview.installedOnDisk).toBe(true);

    const result = await handleInstallFromUrl(preview.url, undefined, approval(preview, true));

    expect(result).toEqual({ status: "installed", pluginId: "acme.upgraded" });
    expect(recordedHash("acme.upgraded")).toBe(preview.archiveHash);
    expect(await installedDir("acme.upgraded")).toBe(true);
    await expect(fs.access(path.join(pluginsRoot, "acme.upgraded", "v2.txt"))).resolves.toBe(
      undefined
    );
  });

  it("finds an install the plugin list can't show, so it can be replaced", async () => {
    // Installed once, but its plugin.json no longer validates: it never loads,
    // so no list row says it is there. The installer still sees its folder.
    await fs.mkdir(path.join(pluginsRoot, "acme.broken"), { recursive: true });
    await fs.writeFile(path.join(pluginsRoot, "acme.broken", "plugin.json"), "{ not json");
    const fixed = await makeArchive({ name: "acme.broken", version: "1.0.1" }, { "ok.txt": "1" });
    servesInOrder(fixed, fixed, fixed);
    const preview = await review();

    expect(preview.installedOnDisk).toBe(true);
    // A fresh-install binding could never land on it...
    const fresh = await handleInstallFromUrl(preview.url, undefined, approval(preview, false));
    expect(fresh.status).toBe("failed");
    // ...and the replacement the review offers instead does.
    const replaced = await handleInstallFromUrl(preview.url, undefined, approval(preview, true));
    expect(replaced).toEqual({ status: "installed", pluginId: "acme.broken" });
    await expect(
      fs.readFile(path.join(pluginsRoot, "acme.broken", "ok.txt"), "utf8")
    ).resolves.toBe("1");
  });

  it("answers a cancel that lands while the download is being read", async () => {
    const jobId = "0d6c2a1e-5b4f-4e3a-9c8d-7e6f5a4b3c2d";
    const archive = await makeArchive({ name: "acme.slow", version: "1.0.0" });
    servesInOrder(archive);
    let releaseHash!: () => void;
    const hashing = new Promise<void>((resolve) => (releaseHash = resolve));
    const realHash = PluginArchive.computeArchiveHash;
    const hash = vi.spyOn(PluginArchive, "computeArchiveHash").mockImplementation(async (p) => {
      await hashing;
      return realHash(p);
    });
    expect(pluginInstallJobs.begin(jobId, () => {})).toBeTruthy();

    try {
      const pending = handlePreviewFromUrl(URL, jobId);
      await vi.waitFor(() => expect(hash).toHaveBeenCalled());
      expect(pluginInstallJobs.cancel(jobId)).toBe(true);
      releaseHash();

      // The read finished cleanly, but the user had already said no.
      await expect(pending).resolves.toEqual({ status: "cancelled" });
      expect(await downloadsLeft()).toEqual([]);
    } finally {
      hash.mockRestore();
      pluginInstallJobs.end(jobId);
    }
  });

  it("makes an archive's own entry names safe to show when it can't be read", async () => {
    // The manifest reader quotes the first entry's name, which the author
    // picks. Astral characters check the clamp counts code points, not units.
    const hostile = await zipWithEntry(`\u202E${"\u{1F600}".repeat(300)}.txt`);
    servesInOrder(hostile);

    const result = await handlePreviewFromUrl(URL);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    const message = result.errors[0]!.message;
    const prefix = "The download isn't a valid plugin archive: ";
    expect(message.startsWith(prefix)).toBe(true);
    const detail = message.slice(prefix.length);
    // The reason survives, without the bidi override, cut at 200 code points.
    expect(detail.startsWith('First entry must be plugin.json, got "\u{1F600}')).toBe(true);
    expect(detail).not.toContain("\u202E");
    expect([...detail]).toHaveLength(201);
    expect(detail.endsWith("\u{1F600}…")).toBe(true);
  });

  it("keeps a short reason whole", async () => {
    servesInOrder(await zipWithEntry("readme.txt"));

    const result = await handlePreviewFromUrl(URL);

    expect(result).toEqual({
      status: "failed",
      errors: [
        {
          code: "archive_invalid",
          message:
            'The download isn\'t a valid plugin archive: First entry must be plugin.json, got "readme.txt"',
        },
      ],
    });
  });

  it("answers a cancel that lands while it checks what's installed", async () => {
    const jobId = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    servesInOrder(await makeArchive({ name: "acme.probed", version: "1.0.0" }));
    let releaseProbe!: () => void;
    serviceRef.gate = new Promise<void>((resolve) => (releaseProbe = resolve));
    expect(pluginInstallJobs.begin(jobId, () => {})).toBeTruthy();

    try {
      const pending = handlePreviewFromUrl(URL, jobId);
      await vi.waitFor(() => expect(serviceRef.lookups).toBe(1));
      expect(pluginInstallJobs.cancel(jobId)).toBe(true);
      releaseProbe();

      await expect(pending).resolves.toEqual({ status: "cancelled" });
      expect(await downloadsLeft()).toEqual([]);
    } finally {
      pluginInstallJobs.end(jobId);
    }
  });

  it("reports a download that isn't a plugin archive, and removes it", async () => {
    netFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/zip" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("not a zip archive"));
          controller.close();
        },
      }),
    }));

    const result = await handlePreviewFromUrl(URL);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errors[0]?.code).toBe("archive_invalid");
      // A short reason is kept whole, not reduced to the prefix.
      expect(result.errors[0]?.message).toMatch(/isn't a valid plugin archive: \S/);
    }
    expect(await downloadsLeft()).toEqual([]);
  });

  it("stops a cancelled review download and removes what it wrote", async () => {
    const jobId = "6b0f0c3e-1d2a-4c5b-8e9f-0a1b2c3d4e5f";
    let sent = false;
    netFetch.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/zip" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          // A real body errors once the request's signal aborts.
          init.signal.addEventListener("abort", () =>
            controller.error(new DOMException("The operation was aborted", "AbortError"))
          );
        },
        pull(controller) {
          if (sent) return new Promise<void>(() => {});
          sent = true;
          controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
        },
      }),
    }));
    expect(pluginInstallJobs.begin(jobId, () => {})).toBeTruthy();

    try {
      const pending = handlePreviewFromUrl(URL, jobId);
      await vi.waitFor(() => expect(sent).toBe(true));
      expect(pluginInstallJobs.cancel(jobId)).toBe(true);

      await expect(pending).resolves.toEqual({ status: "cancelled" });
      expect(await downloadsLeft()).toEqual([]);
    } finally {
      pluginInstallJobs.end(jobId);
    }
  });

  it("refuses a URL it would refuse to install, before fetching anything", async () => {
    for (const url of ["", "file:///etc/passwd", "https://user:pw@example.com/a.dntr"]) {
      await expect(handlePreviewFromUrl(url)).resolves.toEqual({ status: "invalid-url" });
    }
    expect(netFetch).not.toHaveBeenCalled();
  });
});

function record(pluginId: string): InstalledPluginRecord | undefined {
  const plugins = storeMock._state.get("plugins") as
    { installed: Record<string, InstalledPluginRecord> } | undefined;
  return plugins?.installed[pluginId];
}

function failureCode(result: PluginInstallResult | PluginUrlInstallPreviewResult) {
  return result.status === "failed" ? result.errors[0]?.code : result.status;
}

function failureMessage(result: PluginInstallResult | PluginUrlInstallPreviewResult) {
  return result.status === "failed" ? result.errors[0]?.message : undefined;
}

describe("a URL install pinned to a digest (#16779)", () => {
  it("previews an archive with the pinned digest, and installs it", async () => {
    const archive = await makeArchive({ name: "acme.pinned", version: "1.0.0" });
    servesInOrder(archive, archive);
    const digest = await sha256(archive);

    const result = await handlePreviewFromUrl(URL, undefined, digest);
    if (result.status !== "preview") throw new Error(JSON.stringify(result));
    expect(result.preview.archiveHash).toBe(digest);
    expect(result.preview.catalog).toBeUndefined();

    const installed = await handleInstallFromUrl(URL, undefined, approval(result.preview, false));
    expect(installed).toEqual({ status: "installed", pluginId: "acme.pinned" });
    expect(record("acme.pinned")).toMatchObject({ source: "url", catalog: null });
  });

  it("refuses other bytes before reading them as an archive", async () => {
    // Not a zip at all: an unpinned preview reports archive_invalid, so a
    // digest_mismatch here shows the digest was checked before the manifest.
    netFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/zip" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("not the reviewed bytes"));
          controller.close();
        },
      }),
    }));

    const result = await handlePreviewFromUrl(URL, undefined, "f".repeat(64));

    expect(failureCode(result)).toBe("digest_mismatch");
    expect(failureMessage(result)).toMatch(/SHA-256 doesn't match the one in the link/);
    expect(await downloadsLeft()).toEqual([]);
  });

  it("refuses a malformed digest or a plaintext URL before fetching anything", async () => {
    for (const digest of ["", "abc", "F".repeat(64), `${"a".repeat(63)}g`]) {
      expect(failureCode(await handlePreviewFromUrl(URL, undefined, digest))).toBe(
        "digest_invalid"
      );
    }
    await expect(
      handlePreviewFromUrl("http://example.com/acme.dntr", undefined, "a".repeat(64))
    ).resolves.toEqual({ status: "invalid-url" });
    expect(netFetch).not.toHaveBeenCalled();
  });
});

describe("a catalog install (#16779)", () => {
  const REPO = "https://github.com/acme/listed";
  const ENTRY_URL = `${REPO}/releases/download/v1.2.0/acme.listed-1.2.0.dntr`;

  async function listedRelease(manifest: Record<string, unknown> = {}) {
    const archive = await makeArchive({ name: "acme.listed", version: "1.2.0", ...manifest });
    const entry = {
      id: "acme.listed",
      repo: REPO,
      version: "1.2.0",
      url: ENTRY_URL,
      sha256: await sha256(archive),
      capabilities: [],
    };
    return { archive, entry };
  }

  function catalogLists(...entries: Array<Record<string, unknown> | null>) {
    for (const entry of entries) {
      catalogMock.lookup.mockResolvedValueOnce(
        entry === null
          ? { status: "not-listed", fetchedAt: 1 }
          : { status: "listed", entry, fetchedAt: 1 }
      );
    }
  }

  async function catalogReview(version?: string): Promise<PluginUrlInstallPreview> {
    const result = await handlePreviewFromCatalog(
      version === undefined ? { pluginId: "acme.listed" } : { pluginId: "acme.listed", version }
    );
    if (result.status !== "preview") throw new Error(JSON.stringify(result));
    return result.preview;
  }

  function confirm(preview: PluginUrlInstallPreview, overrides: Record<string, unknown> = {}) {
    return handleInstallFromCatalog({
      pluginId: preview.catalog!.id,
      version: preview.catalog!.version,
      repo: preview.catalog!.repo,
      expected: approval(preview, false),
      ...overrides,
    });
  }

  it("previews the newest release the catalog resolves, fetching only the entry's URL", async () => {
    const { archive, entry } = await listedRelease({ capabilities: ["shell:exec"] });
    catalogLists(entry);
    servesInOrder(archive);

    const preview = await catalogReview();

    expect(catalogMock.lookup).toHaveBeenCalledWith("acme.listed", undefined);
    expect(netFetch.mock.calls[0]?.[0]).toBe(ENTRY_URL);
    expect(preview).toMatchObject({
      url: ENTRY_URL,
      archiveHash: entry.sha256,
      catalog: { id: "acme.listed", version: "1.2.0", repo: REPO },
      manifest: { name: "acme.listed", version: "1.2.0", capabilities: ["shell:exec"] },
    });
    expect(await installedDir("acme.listed")).toBe(false);
    expect(await downloadsLeft()).toEqual([]);
  });

  it("installs the reviewed release from a fresh lookup, recording its listing", async () => {
    const { archive, entry } = await listedRelease();
    catalogLists(entry, entry);
    servesInOrder(archive, archive);
    const preview = await catalogReview("1.2.0");

    const result = await confirm(preview);

    expect(result).toEqual({ status: "installed", pluginId: "acme.listed" });
    expect(catalogMock.lookup).toHaveBeenLastCalledWith("acme.listed", "1.2.0");
    expect(record("acme.listed")).toMatchObject({
      source: "catalog",
      catalog: { id: "acme.listed", version: "1.2.0", repo: REPO },
      originalUrl: ENTRY_URL,
      archiveHash: entry.sha256,
    });
  });

  it("drops the listing when a URL install replaces a catalog install", async () => {
    const { archive, entry } = await listedRelease();
    catalogLists(entry, entry);
    servesInOrder(archive, archive);
    await confirm(await catalogReview());
    const replacement = await makeArchive({ name: "acme.listed", version: "1.3.0" });
    servesInOrder(replacement);

    const result = await handleInstallFromUrl(URL, undefined, {
      kind: "update",
      pluginId: "acme.listed",
      archiveHash: await sha256(replacement),
    });

    expect(result).toEqual({ status: "installed", pluginId: "acme.listed" });
    expect(record("acme.listed")).toMatchObject({ source: "url", catalog: null, originalUrl: URL });
  });

  it("holds the confirm to the reviewed digest when the server swaps the bytes", async () => {
    const { archive, entry } = await listedRelease();
    const swapped = await makeArchive(
      { name: "acme.listed", version: "1.2.0" },
      { "dist/index.js": "module.exports = { swapped: true };" }
    );
    catalogLists(entry, entry);
    servesInOrder(archive, swapped);
    const preview = await catalogReview();

    const result = await confirm(preview);

    expect(failureCode(result)).toBe("archive_mismatch");
    expect(await installedDir("acme.listed")).toBe(false);
    expect(record("acme.listed")).toBeUndefined();
    expect(await downloadsLeft()).toEqual([]);
  });

  it("refuses an archive that isn't the reviewed digest", async () => {
    const { archive, entry } = await listedRelease();
    catalogLists({ ...entry, sha256: "e".repeat(64) });
    servesInOrder(archive);

    const result = await handlePreviewFromCatalog({ pluginId: "acme.listed" });

    expect(failureCode(result)).toBe("digest_mismatch");
    expect(failureMessage(result)).toMatch(/isn't the one the plugin catalog reviewed/);
    expect(await downloadsLeft()).toEqual([]);
  });

  it("refuses an archive that names another version than its entry", async () => {
    const { archive, entry } = await listedRelease({ version: "1.1.9" });
    catalogLists(entry);
    servesInOrder(archive);

    const result = await handlePreviewFromCatalog({ pluginId: "acme.listed" });

    expect(failureCode(result)).toBe("catalog_mismatch");
  });

  it("says which way the catalog failed, and downloads nothing", async () => {
    const cases: Array<[unknown, string, RegExp]> = [
      [{ status: "not-listed", fetchedAt: 1 }, "catalog_not_listed", /doesn't list "acme\.listed"/],
      [
        { status: "stale", fetchedAt: 1, failure: "unreachable" },
        "catalog_stale",
        /couldn't be refreshed/,
      ],
      [
        { status: "unavailable", failure: "not-published" },
        "catalog_unavailable",
        /isn't published yet/,
      ],
      [{ status: "unavailable", failure: "unreachable" }, "catalog_unavailable", /Couldn't reach/],
      [{ status: "unavailable", failure: "invalid" }, "catalog_unavailable", /couldn't be read/],
    ];
    for (const [lookup, code, message] of cases) {
      catalogMock.lookup.mockResolvedValueOnce(lookup);
      const result = await handlePreviewFromCatalog({ pluginId: "acme.listed" });
      expect(failureCode(result)).toBe(code);
      expect(failureMessage(result)).toMatch(message);
    }
    expect(netFetch).not.toHaveBeenCalled();
  });

  it("names the version a link asked for when it isn't listed", async () => {
    catalogLists(null);
    const result = await handlePreviewFromCatalog({ pluginId: "acme.listed", version: "9.0.0" });
    expect(failureMessage(result)).toMatch(/doesn't list version 9\.0\.0 of "acme\.listed"/);
  });

  it("refuses the confirm when the release was delisted since the review", async () => {
    const { archive, entry } = await listedRelease();
    catalogLists(entry, null);
    servesInOrder(archive);
    const preview = await catalogReview();

    const result = await confirm(preview);

    expect(failureCode(result)).toBe("catalog_not_listed");
    expect(netFetch).toHaveBeenCalledTimes(1);
    expect(await installedDir("acme.listed")).toBe(false);
  });

  it("refuses the confirm when the listing's digest or repository changed", async () => {
    const { archive, entry } = await listedRelease();
    catalogLists(
      entry,
      { ...entry, sha256: "d".repeat(64) },
      { ...entry, repo: "https://github.com/acme/elsewhere" }
    );
    servesInOrder(archive);
    const preview = await catalogReview();

    expect(failureCode(await confirm(preview))).toBe("catalog_mismatch");
    expect(failureCode(await confirm(preview))).toBe("catalog_mismatch");
    expect(netFetch).toHaveBeenCalledTimes(1);
    expect(await installedDir("acme.listed")).toBe(false);
  });

  it("refuses a confirm whose binding doesn't name the release", async () => {
    const { archive, entry } = await listedRelease();
    catalogLists(entry);
    servesInOrder(archive);
    const preview = await catalogReview();

    for (const expected of [
      undefined,
      { kind: "install", archiveHash: entry.sha256 },
      { kind: "install", pluginId: "acme.other", archiveHash: entry.sha256 },
      { kind: "install", pluginId: "acme.listed", archiveHash: "nope" },
    ]) {
      expect(failureCode(await confirm(preview, { expected }))).toBe("archive_mismatch");
    }
    expect(catalogMock.lookup).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed request before asking the catalog", async () => {
    for (const request of [
      { pluginId: "daintree.builtin" },
      { pluginId: "Not Valid" },
      { pluginId: "acme.listed", version: "v1.2.0" },
      null,
    ]) {
      expect(failureCode(await handlePreviewFromCatalog(request as never))).toBe(
        "catalog_not_listed"
      );
    }
    expect(catalogMock.lookup).not.toHaveBeenCalled();
  });

  it("asks the catalog for any version semver allows, however long", async () => {
    const version = `1.2.0+${"a".repeat(200)}`;
    catalogLists(null);
    await handlePreviewFromCatalog({ pluginId: "acme.listed", version });
    expect(catalogMock.lookup).toHaveBeenCalledWith("acme.listed", version);
  });

  it("never starts a download the user cancelled while the catalog was read", async () => {
    const { archive, entry } = await listedRelease();
    catalogLists(entry);
    servesInOrder(archive);
    const preview = await catalogReview();
    netFetch.mockClear();
    // Through the IPC entry points, so the job the cancel names is the one
    // they register.
    const steps: Array<[string, (jobId: string) => Promise<unknown>]> = [
      [
        "7c1e0d4f-2e3b-4d6c-9f0a-1b2c3d4e5f60",
        (jobId) => handlePreviewFromCatalogOp({} as never, { pluginId: "acme.listed" }, jobId),
      ],
      [
        "8d2f1e5a-3f4c-4e7d-8a1b-2c3d4e5f6071",
        (jobId) =>
          handleInstallFromCatalogOp(
            {} as never,
            {
              pluginId: "acme.listed",
              version: "1.2.0",
              repo: REPO,
              expected: approval(preview, false),
            },
            jobId
          ),
      ],
    ];
    for (const [jobId, start] of steps) {
      let answer!: (value: unknown) => void;
      catalogMock.lookup.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
      const calls = catalogMock.lookup.mock.calls.length;
      const pending = start(jobId);
      await vi.waitFor(() => expect(catalogMock.lookup.mock.calls.length).toBe(calls + 1));
      expect(handleCancelInstall(jobId)).toBe(true);
      answer({ status: "listed", entry, fetchedAt: 1 });

      await expect(pending).resolves.toEqual({ status: "cancelled" });
    }
    expect(netFetch).not.toHaveBeenCalled();
    expect(await installedDir("acme.listed")).toBe(false);
  });

  it("won't let the generic install claim a catalog listing", async () => {
    const archive = await makeArchive({ name: "acme.forged", version: "1.0.0" });
    for (const opts of [
      { source: "catalog" as const },
      { source: "url" as const, catalog: { id: "acme.forged", version: "1.0.0", repo: REPO } },
    ]) {
      expect(failureCode(await handleInstall(archive, opts))).toBe("catalog_mismatch");
    }
    expect(await installedDir("acme.forged")).toBe(false);
  });
});
