// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os, { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((key: string) => `/mock/electron/${key}`),
    getVersion: vi.fn(() => "0.15.0"),
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  webContents: { getAllWebContents: vi.fn(() => []) },
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

// The window itself is covered by pluginPdfRenderer.test.ts; here the render is
// a seam so the gates in front of it and the write after it can be asserted,
// including that a refused call never opens a window at all.
const PDF_BYTES = Buffer.from("%PDF-1.7\n%mock\n%%EOF\n");
const renderMock = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("../plugin/pluginPdfRenderer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin/pluginPdfRenderer.js")>()),
  renderHtmlToPdf: renderMock.render,
}));

import { PluginService } from "../PluginService.js";
import {
  getPluginCapabilityConsentService,
  _resetPluginCapabilityServicesForTest,
} from "../plugin-capability/instances.js";
import type { PluginManifest, PluginHostApi } from "../../../shared/types/plugin.js";

let svc: PluginService;
let baseDir: string;
let allowed: string;
let homeDir: string;
let homedirSpy: MockInstance<() => string>;

function dataDir(): string {
  return join(homeDir, ".daintree", "plugin-data", "acme.docs");
}

function registerPlugin(
  capabilities: string[],
  allowedPaths: string[] = [allowed],
  isBuiltin = false
): PluginHostApi {
  const seam = svc as unknown as {
    _registerFakePluginForTests(p: unknown): void;
    _createHostForTests(id: string): PluginHostApi;
  };
  seam._registerFakePluginForTests({
    manifest: {
      name: "acme.docs",
      version: "1.0.0",
      capabilities,
      ...(allowedPaths.length > 0 ? { scopes: { fs: { allowedPaths } } } : {}),
      contributes: { fileDecorationProviders: [], forgeProviders: [] },
    } as unknown as PluginManifest,
    dir: baseDir,
    loadedAt: 0,
    isBuiltin,
  });
  return seam._createHostForTests("acme.docs");
}

beforeEach(async () => {
  appendSpy.mockClear();
  renderMock.render.mockReset();
  renderMock.render.mockResolvedValue(PDF_BYTES);
  baseDir = realpathSync(mkdtempSync(join(tmpdir(), "plugin-docs-")));
  const pluginsRoot = join(baseDir, "plugins");
  mkdirSync(pluginsRoot, { recursive: true });
  allowed = join(baseDir, "allowed");
  await fs.mkdir(allowed, { recursive: true });
  homeDir = join(baseDir, "home");
  await fs.mkdir(homeDir, { recursive: true });
  homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  svc = new PluginService(pluginsRoot);
  getPluginCapabilityConsentService().setConsentBridge(async () => "approved-once");
});

afterEach(() => {
  homedirSpy.mockRestore();
  _resetPluginCapabilityServicesForTest();
  rmSync(baseDir, { recursive: true, force: true });
});

describe("host.documents.renderPdf", () => {
  it("writes the rendered PDF inside scope and resolves its path, size and revision", async () => {
    const host = registerPlugin(["fs:project-write"]);
    const outputPath = join(allowed, "invoice.pdf");

    const result = await host.documents.renderPdf({ html: "<h1>Invoice</h1>", outputPath });

    expect(result).toEqual({
      path: outputPath,
      bytes: PDF_BYTES.byteLength,
      revision: createHash("sha256").update(PDF_BYTES).digest("hex"),
    });
    expect(await fs.readFile(outputPath)).toEqual(PDF_BYTES);
    expect(renderMock.render).toHaveBeenCalledWith({
      source: { kind: "html", html: "<h1>Invoice</h1>" },
      // No project read capability, so inline HTML may load no local files.
      resourceRoot: null,
      print: { pageSize: "A4", printBackground: true, preferCSSPageSize: false },
    });
  });

  it("audits the write on the fs-write trail", async () => {
    const host = registerPlugin(["fs:project-write"]);
    await host.documents.renderPdf({ html: "<p/>", outputPath: join(allowed, "a.pdf") });
    const audits = appendSpy.mock.calls
      .map((c) => c[0] as { channel: string; actionId: string })
      .filter((a) => a.channel === "plugin:fs-write");
    expect(audits).toHaveLength(1);
    expect(audits[0].actionId).toBe(`documents.renderPdf:${join(allowed, "a.pdf")}`);
  });

  it("returns the same revision fs.writeFile would, and replaces an existing file atomically", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"]);
    const outputPath = join(allowed, "report.pdf");
    await fs.writeFile(outputPath, "old", { mode: 0o640 });
    const { revision } = await host.documents.renderPdf({ html: "<p/>", outputPath });
    const bytes = await host.fs.readFileBytes(outputPath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(revision);
    expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o640);
  });

  it("writes into the plugin's own data dir, creating the dir on first use", async () => {
    const host = registerPlugin(["fs:user-data-write"], []);
    const outputPath = join(dataDir(), "q.pdf");
    const result = await host.documents.renderPdf({ html: "<p/>", outputPath });
    expect(result.path).toBe(outputPath);
    expect(await fs.readFile(outputPath)).toEqual(PDF_BYTES);
  });

  it("gives inline HTML the output root for file: resources only when the plugin can read it", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"]);
    await host.documents.renderPdf({ html: "<p/>", outputPath: join(allowed, "a.pdf") });
    expect(renderMock.render.mock.calls[0][0].resourceRoot).toBe(allowed);
  });

  it("renders an htmlPath source from its contained path, scoped to its root", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"]);
    const htmlPath = join(allowed, "invoice.html");
    await fs.writeFile(htmlPath, "<p/>");
    await host.documents.renderPdf({
      htmlPath,
      outputPath: join(allowed, "invoice.pdf"),
      pageSize: "Letter",
      landscape: true,
      margins: { top: 0.5 },
    });
    expect(renderMock.render).toHaveBeenCalledWith({
      source: { kind: "file", file: htmlPath },
      resourceRoot: allowed,
      print: {
        pageSize: "Letter",
        printBackground: true,
        preferCSSPageSize: false,
        landscape: true,
        margins: { top: 0.5 },
      },
    });
  });

  describe("refusals never open a render window", () => {
    afterEach(() => expect(renderMock.render).not.toHaveBeenCalled());

    it("refuses a plugin with no fs write capability", async () => {
      const host = registerPlugin(["fs:project-read"]);
      await expect(
        host.documents.renderPdf({ html: "<p/>", outputPath: join(allowed, "a.pdf") })
      ).rejects.toThrow(/^PERMISSION_REQUIRED: .*"fs:project-write" or "fs:user-data-write"/);
    });

    it("refuses a write cap of the wrong root class", async () => {
      const host = registerPlugin(["fs:user-data-write"]);
      await expect(
        host.documents.renderPdf({ html: "<p/>", outputPath: join(allowed, "a.pdf") })
      ).rejects.toThrow(/PERMISSION_REQUIRED: .*"fs:project-write" capability for the output/);
    });

    it("refuses invalid options before touching the filesystem", async () => {
      const host = registerPlugin(["fs:project-write"]);
      await expect(
        host.documents.renderPdf({
          html: "<p/>",
          outputPath: join(allowed, "a.pdf"),
          scale: 2,
        } as never)
      ).rejects.toThrow(/^VALIDATION: .*unknown option "scale"/);
      await expect(
        host.documents.renderPdf({ html: "<p/>", outputPath: join(allowed, "a.txt") })
      ).rejects.toThrow(/must end in \.pdf/);
    });

    it("refuses an output path outside every allowed root", async () => {
      const host = registerPlugin(["fs:project-write"]);
      await expect(
        host.documents.renderPdf({ html: "<p/>", outputPath: join(baseDir, "escape.pdf") })
      ).rejects.toThrow(/PATH_NOT_ALLOWED/);
      await expect(
        host.documents.renderPdf({
          html: "<p/>",
          outputPath: join(allowed, "..", "escape.pdf"),
        })
      ).rejects.toThrow(/PATH_NOT_ALLOWED/);
    });

    it("refuses an output whose parent directory does not exist", async () => {
      const host = registerPlugin(["fs:project-write"]);
      await expect(
        host.documents.renderPdf({ html: "<p/>", outputPath: join(allowed, "nope", "a.pdf") })
      ).rejects.toThrow(/INVALID_PATH: .*parent directory does not exist/);
    });

    it("refuses an htmlPath the plugin may not read", async () => {
      const host = registerPlugin(["fs:project-write"]);
      const htmlPath = join(allowed, "in.html");
      await fs.writeFile(htmlPath, "<p/>");
      await expect(
        host.documents.renderPdf({ htmlPath, outputPath: join(allowed, "a.pdf") })
      ).rejects.toThrow(/PERMISSION_REQUIRED: .*"fs:project-read" capability for htmlPath/);
    });

    it("refuses an htmlPath outside scope, even through a symlink", async () => {
      const host = registerPlugin(["fs:project-read", "fs:project-write"]);
      const secret = join(baseDir, "secret.html");
      await fs.writeFile(secret, "<p>secret</p>");
      await fs.symlink(secret, join(allowed, "link.html"));
      await expect(
        host.documents.renderPdf({ htmlPath: secret, outputPath: join(allowed, "a.pdf") })
      ).rejects.toThrow(/PATH_NOT_ALLOWED/);
      await expect(
        host.documents.renderPdf({
          htmlPath: join(allowed, "link.html"),
          outputPath: join(allowed, "a.pdf"),
        })
      ).rejects.toThrow(/PATH_NOT_ALLOWED/);
    });

    it("refuses an htmlPath that is a directory", async () => {
      const host = registerPlugin(["fs:project-read", "fs:project-write"]);
      await fs.mkdir(join(allowed, "dir.html"));
      await expect(
        host.documents.renderPdf({
          htmlPath: join(allowed, "dir.html"),
          outputPath: join(allowed, "a.pdf"),
        })
      ).rejects.toThrow(/INVALID_PATH: .*htmlPath is not a file/);
    });

    it("refuses when the user denies write consent", async () => {
      getPluginCapabilityConsentService().setConsentBridge(async () => "rejected");
      const host = registerPlugin(["fs:project-write"]);
      await expect(
        host.documents.renderPdf({ html: "<p/>", outputPath: join(allowed, "a.pdf") })
      ).rejects.toThrow(/PERMISSION_REQUIRED/);
      await expect(fs.stat(join(allowed, "a.pdf"))).rejects.toThrow();
    });
  });

  it("refuses to write through a symlinked output leaf and leaves its target alone", async () => {
    const host = registerPlugin(["fs:project-write"]);
    const real = join(allowed, "real.pdf");
    await fs.writeFile(real, "keep");
    await fs.symlink(real, join(allowed, "link.pdf"));
    await expect(
      host.documents.renderPdf({ html: "<p/>", outputPath: join(allowed, "link.pdf") })
    ).rejects.toThrow(/^TARGET_IS_SYMLINK:/);
    expect(await fs.readFile(real, "utf-8")).toBe("keep");
    expect(renderMock.render).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ channel: "plugin:fs-write" })
    );
  });

  it("refuses a leaf swapped for a symlink while the render was running", async () => {
    const host = registerPlugin(["fs:project-write"]);
    const outputPath = join(allowed, "late.pdf");
    const other = join(allowed, "other.pdf");
    await fs.writeFile(other, "keep");
    renderMock.render.mockImplementationOnce(async () => {
      await fs.symlink(other, outputPath);
      return PDF_BYTES;
    });
    // Containment of the swapped leaf now lands on `other.pdf`, so the recheck
    // reports the move before the leaf check gets to name the symlink.
    await expect(host.documents.renderPdf({ html: "<p/>", outputPath })).rejects.toThrow(
      /^TARGET_UNAVAILABLE:/
    );
    expect(await fs.readFile(other, "utf-8")).toBe("keep");
  });

  it("surfaces a render failure without writing anything", async () => {
    const host = registerPlugin(["fs:project-write"]);
    renderMock.render.mockRejectedValueOnce(new Error("RENDER_TIMEOUT: render exceeded 30000 ms"));
    const outputPath = join(allowed, "slow.pdf");
    await expect(host.documents.renderPdf({ html: "<p/>", outputPath })).rejects.toThrow(
      /^RENDER_TIMEOUT:/
    );
    await expect(fs.stat(outputPath)).rejects.toThrow();
  });
});
