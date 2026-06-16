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
  // unloadPlugin broadcasts plugin-agent changes to all renderers; without a
  // BrowserWindow stub that path throws asynchronously after the test ends.
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  webContents: { getAllWebContents: vi.fn(() => []) },
  clipboard: {
    writeText: vi.fn(),
    readText: vi.fn(() => ""),
  },
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

import { clipboard } from "electron";
import { PluginService } from "../PluginService.js";
import type { PluginManifest, PluginHostApi } from "../../../shared/types/plugin.js";

const mockClipboard = vi.mocked(clipboard);

let svc: PluginService;
let baseDir: string;

interface FakeLoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  loadedAt: number;
  isBuiltin: boolean;
}

function makeManifest(capabilities: string[]): PluginManifest {
  return {
    name: "acme.clip",
    version: "1.0.0",
    capabilities,
    scopes: { fs: { allowedPaths: [] } },
    contributes: { fileDecorationProviders: [], forgeProviders: [] },
  } as unknown as PluginManifest;
}

function registerPlugin(capabilities: string[]): PluginHostApi {
  const seam = svc as unknown as {
    _registerFakePluginForTests(p: FakeLoadedPlugin): void;
    _createHostForTests(id: string): PluginHostApi;
  };
  seam._registerFakePluginForTests({
    manifest: makeManifest(capabilities),
    dir: baseDir,
    loadedAt: 0,
    isBuiltin: false,
  });
  return seam._createHostForTests("acme.clip");
}

beforeEach(() => {
  mockClipboard.writeText.mockClear();
  mockClipboard.readText.mockClear();
  mockClipboard.readText.mockReturnValue("");
  baseDir = mkdtempSync(join(tmpdir(), "plugin-clip-"));
  const pluginsRoot = join(baseDir, "plugins");
  mkdirSync(pluginsRoot, { recursive: true });
  svc = new PluginService(pluginsRoot);
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("host.clipboard capability gating", () => {
  it("writes text when clipboard:write is declared", async () => {
    const host = registerPlugin(["clipboard:write"]);
    await host.clipboard.writeText("hello");
    expect(mockClipboard.writeText).toHaveBeenCalledWith("hello");
  });

  it("rejects writeText without clipboard:write", async () => {
    const host = registerPlugin([]);
    await expect(host.clipboard.writeText("nope")).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });

  it("reads text when clipboard:read is declared", async () => {
    mockClipboard.readText.mockReturnValue("from-os");
    const host = registerPlugin(["clipboard:read"]);
    expect(await host.clipboard.readText()).toBe("from-os");
  });

  it("rejects readText without clipboard:read", async () => {
    const host = registerPlugin([]);
    await expect(host.clipboard.readText()).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(mockClipboard.readText).not.toHaveBeenCalled();
  });

  it("returns the empty string for non-text / empty clipboard content", async () => {
    mockClipboard.readText.mockReturnValue("");
    const host = registerPlugin(["clipboard:read"]);
    expect(await host.clipboard.readText()).toBe("");
  });

  it("write and read are independently gated", async () => {
    // A plugin declaring only write cannot read, and vice versa.
    const writeOnly = registerPlugin(["clipboard:write"]);
    await expect(writeOnly.clipboard.readText()).rejects.toThrow(/PERMISSION_REQUIRED/);

    svc.unloadPlugin("acme.clip");
    mockClipboard.writeText.mockClear();

    const readOnly = registerPlugin(["clipboard:read"]);
    await expect(readOnly.clipboard.writeText("x")).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });
});

describe("host.clipboard liveness guard", () => {
  it("rejects with PLUGIN_UNLOADED before the capability check after unload", async () => {
    const host = registerPlugin(["clipboard:read", "clipboard:write"]);
    svc.unloadPlugin("acme.clip");

    // Liveness fires first: an unloaded plugin reports PLUGIN_UNLOADED, never
    // PERMISSION_REQUIRED — declaredCapabilities() returns [] post-unload, so a
    // capability check first would mis-report a permission error.
    await expect(host.clipboard.writeText("x")).rejects.toThrow(/PLUGIN_UNLOADED/);
    await expect(host.clipboard.readText()).rejects.toThrow(/PLUGIN_UNLOADED/);
    expect(mockClipboard.writeText).not.toHaveBeenCalled();
    expect(mockClipboard.readText).not.toHaveBeenCalled();
  });
});

describe("host.clipboard write size guard", () => {
  const LIMIT = 8 * 1024 * 1024;

  it("accepts text exactly at the 8 MiB byte limit", async () => {
    const host = registerPlugin(["clipboard:write"]);
    const atLimit = "a".repeat(LIMIT);
    await expect(host.clipboard.writeText(atLimit)).resolves.toBeUndefined();
    expect(mockClipboard.writeText).toHaveBeenCalledWith(atLimit);
  });

  it("rejects text one byte over the limit", async () => {
    const host = registerPlugin(["clipboard:write"]);
    const overLimit = "a".repeat(LIMIT + 1);
    await expect(host.clipboard.writeText(overLimit)).rejects.toThrow(/PAYLOAD_TOO_LARGE/);
    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });

  it("accepts multi-byte text exactly at the byte limit", async () => {
    const host = registerPlugin(["clipboard:write"]);
    // 4-byte emoji × (LIMIT / 4) === exactly 8 MiB UTF-8, well under LIMIT by
    // .length — exercises the boundary on the byte axis, not the char axis.
    const atLimit = "😀".repeat(LIMIT / 4);
    expect(Buffer.byteLength(atLimit, "utf8")).toBe(LIMIT);
    await expect(host.clipboard.writeText(atLimit)).resolves.toBeUndefined();
    expect(mockClipboard.writeText).toHaveBeenCalledWith(atLimit);
  });

  it("measures by UTF-8 byte length, not JS string length (multi-byte chars)", async () => {
    const host = registerPlugin(["clipboard:write"]);
    // "😀" is 2 UTF-16 code units (.length === 2) but 4 UTF-8 bytes. A string
    // whose .length is under the limit can still exceed it by byte count.
    const emojiCount = Math.floor(LIMIT / 4) + 1; // > 8 MiB by bytes
    const payload = "😀".repeat(emojiCount);
    expect(payload.length).toBeLessThan(LIMIT); // under the limit by .length
    await expect(host.clipboard.writeText(payload)).rejects.toThrow(/PAYLOAD_TOO_LARGE/);
    expect(mockClipboard.writeText).not.toHaveBeenCalled();
  });
});
