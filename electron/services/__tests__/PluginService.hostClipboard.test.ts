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
    writeImage: vi.fn(),
    readText: vi.fn(() => ""),
  },
  // Mirrors Electron's real contract: createFromBuffer never throws on
  // malformed input, it returns an image whose isEmpty() is true. Bytes
  // starting with the PNG magic number stand in for a decodable image.
  nativeImage: {
    createFromBuffer: vi.fn((buf: Buffer) => ({
      isEmpty: () => !(buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50),
    })),
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

/** Bytes that the nativeImage mock decodes to a non-empty image. */
function pngBytes(length = 8): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
  return bytes;
}

beforeEach(() => {
  mockClipboard.writeImage.mockClear();
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

describe("host.clipboard.writeImage", () => {
  const LIMIT = 20 * 1024 * 1024;

  it("writes a decodable PNG when clipboard:write is declared", async () => {
    const host = registerPlugin(["clipboard:write"]);
    await expect(host.clipboard.writeImage(pngBytes())).resolves.toBeUndefined();
    expect(mockClipboard.writeImage).toHaveBeenCalledTimes(1);
  });

  it("reuses the clipboard:write token rather than requiring a separate one", async () => {
    // Deliberate design choice: an image write is exactly as reversible as a
    // text write, so it must not demand a capability a plugin already
    // holding clipboard:write would have to add (and which would then elevate
    // its actions to confirm).
    const host = registerPlugin(["clipboard:write"]);
    await expect(host.clipboard.writeImage(pngBytes())).resolves.toBeUndefined();
  });

  it("rejects without clipboard:write", async () => {
    const host = registerPlugin(["clipboard:read"]);
    await expect(host.clipboard.writeImage(pngBytes())).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(mockClipboard.writeImage).not.toHaveBeenCalled();
  });

  it("rejects a non-Uint8Array payload", async () => {
    const host = registerPlugin(["clipboard:write"]);
    await expect(host.clipboard.writeImage("not-bytes" as unknown as Uint8Array)).rejects.toThrow(
      /VALIDATION/
    );
    expect(mockClipboard.writeImage).not.toHaveBeenCalled();
  });

  it("rejects bytes that do not decode to an image", async () => {
    // nativeImage.createFromBuffer returns an empty image rather than
    // throwing, so without the isEmpty() check this would silently put a
    // blank image on the clipboard and report success.
    const host = registerPlugin(["clipboard:write"]);
    await expect(host.clipboard.writeImage(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
      /VALIDATION/
    );
    expect(mockClipboard.writeImage).not.toHaveBeenCalled();
  });

  it("rejects a payload one byte over the 20 MiB limit without decoding it", async () => {
    const host = registerPlugin(["clipboard:write"]);
    await expect(host.clipboard.writeImage(pngBytes(LIMIT + 1))).rejects.toThrow(
      /PAYLOAD_TOO_LARGE/
    );
    expect(mockClipboard.writeImage).not.toHaveBeenCalled();
  });

  it("accepts a payload exactly at the limit", async () => {
    const host = registerPlugin(["clipboard:write"]);
    await expect(host.clipboard.writeImage(pngBytes(LIMIT))).resolves.toBeUndefined();
    expect(mockClipboard.writeImage).toHaveBeenCalledTimes(1);
  });

  it("decodes a subarray view's own bytes, not its whole backing buffer", async () => {
    // Buffer.from(view.buffer) without the byteOffset/byteLength triple would
    // hand over the wrong bytes for any caller whose data is a view — and
    // would do so silently, since the leading bytes still look like a PNG.
    const backing = new Uint8Array(64);
    backing.set([0x89, 0x50, 0x4e, 0x47], 16);
    const view = backing.subarray(16, 32);
    const host = registerPlugin(["clipboard:write"]);
    await expect(host.clipboard.writeImage(view)).resolves.toBeUndefined();

    const { nativeImage } = await import("electron");
    const passed = vi.mocked(nativeImage.createFromBuffer).mock.calls.at(-1)?.[0];
    expect(passed?.length).toBe(16);
    expect(passed?.[0]).toBe(0x89);
  });

  it("rejects with PLUGIN_UNLOADED after unload, before the capability check", async () => {
    const host = registerPlugin(["clipboard:write"]);
    svc.unloadPlugin("acme.clip");
    await expect(host.clipboard.writeImage(pngBytes())).rejects.toThrow(/PLUGIN_UNLOADED/);
    expect(mockClipboard.writeImage).not.toHaveBeenCalled();
  });
});
