// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
import type { PluginManifest } from "../../../shared/types/plugin.js";
import { getPluginManifestSchema } from "../../schemas/plugin.js";

let svc: PluginService;
let baseDir: string;

function register(remote?: "supported" | "unsupported"): void {
  const seam = svc as unknown as {
    _registerFakePluginForTests(p: {
      manifest: PluginManifest;
      dir: string;
      loadedAt: number;
      isBuiltin: boolean;
    }): void;
  };
  seam._registerFakePluginForTests({
    manifest: {
      name: "acme.graph",
      version: "1.0.0",
      ...(remote ? { remote } : {}),
      capabilities: [],
      contributes: {
        panels: [{ id: "view", name: "Graph" }],
        views: [],
        fileDecorationProviders: [],
        forgeProviders: [],
      },
    } as unknown as PluginManifest,
    dir: baseDir,
    loadedAt: 0,
    isBuiltin: false,
  });
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "plugin-remote-"));
  mkdirSync(join(baseDir, "plugins"), { recursive: true });
  svc = new PluginService(join(baseDir, "plugins"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('manifest "remote": "unsupported"', () => {
  it("is accepted by the manifest schema, and anything else is not", () => {
    const base = { name: "acme.graph", version: "1.0.0" };
    expect(
      getPluginManifestSchema("user").safeParse({ ...base, remote: "unsupported" }).success
    ).toBe(true);
    expect(
      getPluginManifestSchema("user").safeParse({ ...base, remote: "sometimes" }).success
    ).toBe(false);
  });

  it("is never activated for a window on another machine", async () => {
    register("unsupported");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(svc.isRemoteUnsupported("acme.graph")).toBe(true);
    const result = await svc.activatePluginForView("acme.graph.view", false, {
      remoteFrontend: true,
    });
    expect(result).toMatchObject({ ok: false, remoteUnsupported: { pluginId: "acme.graph" } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"remote": "unsupported"'));
    warn.mockRestore();
  });

  it("defaults to supported", () => {
    register();
    expect(svc.isRemoteUnsupported("acme.graph")).toBe(false);
  });
});
