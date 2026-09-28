// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    getAllProjects: vi.fn(() => []),
    getCurrentProjectId: vi.fn(() => null),
  },
}));

vi.mock("../PluginActionAuditService.js", () => ({
  getPluginActionAuditService: () => ({ append: vi.fn() }),
}));

import { PluginService } from "../PluginService.js";
import { packPluginArchive } from "../PluginArchive.js";
import type { PluginBlocklistService } from "../plugin/PluginBlocklistService.js";
import type { PluginManifest, PluginInstallResult } from "../../../shared/types/plugin.js";

let baseDir: string;
let blocklist: Awaited<ReturnType<PluginBlocklistService["getBlocklist"]>>;
let svc: PluginService;
let installSpy: ReturnType<typeof vi.fn>;

const otherPlatform = process.platform === "linux" ? "darwin" : "linux";

async function makeArchive(manifest: Record<string, unknown>): Promise<string> {
  const src = await fs.mkdtemp(path.join(baseDir, "src-"));
  await fs.writeFile(path.join(src, "plugin.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(src, "index.js"), "export function activate() {}\n");
  const out = path.join(baseDir, `${path.basename(src)}.dntr`);
  await packPluginArchive(src, out);
  return out;
}

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-parity-"));
  blocklist = null;
  svc = new PluginService(path.join(baseDir, "plugins"), "0.38.0", {
    blocklistService: { getBlocklist: async () => blocklist } as unknown as PluginBlocklistService,
  });
  (svc as unknown as { resolveInit: () => void }).resolveInit();
  installSpy = vi.fn(async (): Promise<PluginInstallResult> => ({
    status: "installed",
    pluginId: "acme.graph",
  }));
  (svc as unknown as { installer: { installPlugin: typeof installSpy } }).installer.installPlugin =
    installSpy;
});

afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

function register(name: string): void {
  (
    svc as unknown as {
      _registerFakePluginForTests(p: {
        manifest: PluginManifest;
        dir: string;
        loadedAt: number;
        isBuiltin: boolean;
      }): void;
    }
  )._registerFakePluginForTests({
    manifest: {
      name,
      version: "1.0.0",
      capabilities: [],
      contributes: { panels: [], views: [], fileDecorationProviders: [], forgeProviders: [] },
    } as unknown as PluginManifest,
    dir: baseDir,
    loadedAt: 0,
    isBuiltin: false,
  });
}

describe("installing a package sent from another machine", () => {
  it("refuses a package with no build for this OS before anything is copied", async () => {
    const archive = await makeArchive({
      name: "acme.graph",
      displayName: "Graph View",
      version: "1.0.0",
      platforms: [otherPlatform],
    });
    await expect(svc.installPluginFromAnotherMachine(archive)).rejects.toMatchObject({
      code: "PLUGIN_INCOMPATIBLE",
      details: {
        code: "PLUGIN_INCOMPATIBLE",
        pluginId: "acme.graph",
        reason: { kind: "platform", supported: [otherPlatform] },
      },
    });
    expect(installSpy).not.toHaveBeenCalled();
    expect(existsSync(path.join(baseDir, "plugins", "acme.graph"))).toBe(false);
  });

  it("checks the blocklist before the install path runs", async () => {
    blocklist = {
      entries: [{ name: "acme.graph", ranges: ["*"], reason: "bad", message: "Known malware" }],
    };
    const archive = await makeArchive({ name: "acme.graph", version: "1.0.0" });
    const error = await svc.installPluginFromAnotherMachine(archive).catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: "PLUGIN_INCOMPATIBLE",
      details: { reason: { kind: "untrusted" } },
    });
    expect((error as { userMessage: string }).userMessage).toContain("Known malware");
    expect(installSpy).not.toHaveBeenCalled();
  });

  it("installs an engine mismatch anyway: the range is advisory", async () => {
    const archive = await makeArchive({
      name: "acme.graph",
      version: "1.0.0",
      engines: { daintree: ">=99.0.0" },
    });
    await expect(svc.installPluginFromAnotherMachine(archive)).resolves.toEqual({
      status: "installed",
      pluginId: "acme.graph",
    });
    expect(installSpy).toHaveBeenCalledWith(archive, { source: "sideload" }, expect.any(Function));
  });

  it("refuses a package for a different plugin than the one asked for", async () => {
    const archive = await makeArchive({ name: "acme.other", version: "1.0.0" });
    const result = await svc.installPluginFromAnotherMachine(archive, { pluginId: "acme.graph" });
    expect(result).toMatchObject({ status: "failed", errors: [{ code: "archive_mismatch" }] });
    expect(installSpy).not.toHaveBeenCalled();
  });

  it("hands the installer the replacement rule to apply under its lock", async () => {
    const archive = await makeArchive({ name: "acme.graph", version: "2.0.0" });
    await svc.installPluginFromAnotherMachine(archive, { update: true, jobId: "job-1" });
    const [, options, check] = installSpy.mock.calls[0] as unknown as [
      string,
      unknown,
      (installed: string | null) => string | null,
    ];
    expect(options).toEqual({ source: "sideload", jobId: "job-1" });
    expect(check(null)).toMatch(/no longer installed/);
    expect(check("2.0.0")).toMatch(/isn't newer/);
    expect(check("1.0.0")).toBeNull();
  });
});

describe("typed errors for a window on another machine", () => {
  const remoteCtx = {
    projectId: null,
    worktreeId: null,
    webContentsId: -3,
    pluginId: "acme.gone",
    origin: { kind: "remote" as const, clientId: "c1", endpointId: "e1" },
  };

  it("refuses a call to a plugin this host doesn't have with PLUGIN_NOT_ON_HOST", async () => {
    await expect(svc.dispatchHandler("acme.gone", "ping", remoteCtx, [])).rejects.toMatchObject({
      code: "PLUGIN_NOT_ON_HOST",
      details: { code: "PLUGIN_NOT_ON_HOST", pluginId: "acme.gone", hostId: "local" },
    });
  });

  it("keeps the local refusal unchanged", async () => {
    const localCtx = { projectId: null, worktreeId: null, webContentsId: 7, pluginId: "acme.gone" };
    const error = await svc
      .dispatchHandler("acme.gone", "ping", localCtx, [])
      .catch((err: unknown) => err);
    expect((error as { code?: unknown }).code).toBeUndefined();
    expect(String(error)).toContain("is not loaded");
  });

  it("turns a call the plugin's removal cut short into PLUGIN_NOT_ON_HOST", async () => {
    register("acme.gone");
    let release!: () => void;
    svc.registerHandler("acme.gone", "slow", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("worker exited");
    });
    const call = svc.dispatchHandler("acme.gone", "slow", remoteCtx, []);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    svc.unloadPlugin("acme.gone");
    release();
    await expect(call).rejects.toMatchObject({ code: "PLUGIN_NOT_ON_HOST" });
  });

  it("refuses a saved panel's activation when its plugin isn't on this host", async () => {
    await expect(
      svc.activatePluginForView("acme.gone.view", false, { remoteFrontend: true })
    ).rejects.toMatchObject({ code: "PLUGIN_NOT_ON_HOST", details: { pluginId: "acme.gone" } });
    await expect(svc.activatePluginForView("acme.gone.view", false)).resolves.toEqual({ ok: true });
    // A kind the loaded plugin no longer contributes isn't a missing plugin.
    register("acme.gone");
    await expect(
      svc.activatePluginForView("acme.gone.view", false, { remoteFrontend: true })
    ).resolves.toEqual({ ok: true });
  });
});
