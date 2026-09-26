// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
import { MAX_OUTSTANDING_RENDERS, reserveRender } from "../plugin/pluginPdfRenderer.js";
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
  baseDir = await fs.realpath(mkdtempSync(join(tmpdir(), "plugin-docs-")));
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
      html: "<h1>Invoice</h1>",
      baseUrl: null,
      // No project read capability, so inline HTML may load no local files.
      resourceRoot: null,
      print: { pageSize: "A4", printBackground: true, preferCSSPageSize: false },
      signal: expect.any(AbortSignal),
      timeoutMs: expect.any(Number),
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
    if (process.platform !== "win32") {
      expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o640);
    }
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

  it("renders a snapshot of htmlPath, based at its directory and scoped to its root", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"]);
    await fs.mkdir(join(allowed, "inv"));
    const htmlPath = join(allowed, "inv", "invoice.html");
    await fs.writeFile(htmlPath, "<h1>Caf\u00e9</h1>");
    await host.documents.renderPdf({
      htmlPath,
      outputPath: join(allowed, "invoice.pdf"),
      pageSize: "Letter",
      landscape: true,
      margins: { top: 0.5 },
    });
    expect(renderMock.render).toHaveBeenCalledWith({
      html: "<h1>Caf\u00e9</h1>",
      baseUrl: pathToFileURL(join(allowed, "inv") + "/").href,
      resourceRoot: allowed,
      signal: expect.any(AbortSignal),
      timeoutMs: expect.any(Number),
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

  it.each([
    ["an outside file", () => join(baseDir, "secret.html")],
    ["another in-scope file", () => join(allowed, "other.html")],
  ])(
    "never renders an htmlPath swapped for a symlink to %s while consent was pending",
    async (_label, target) => {
      const host = registerPlugin(["fs:project-read", "fs:project-write"]);
      const htmlPath = join(allowed, "invoice.html");
      await fs.writeFile(htmlPath, "<p>invoice</p>");
      await fs.writeFile(join(baseDir, "secret.html"), "<p>secret</p>");
      await fs.writeFile(join(allowed, "other.html"), "<p>other</p>");
      getPluginCapabilityConsentService().setConsentBridge(async () => {
        await fs.rm(htmlPath);
        await fs.symlink(target(), htmlPath);
        return "approved-once";
      });
      await expect(
        host.documents.renderPdf({ htmlPath, outputPath: join(allowed, "invoice.pdf") })
      ).rejects.toThrow(/^TARGET_UNAVAILABLE:/);
      expect(renderMock.render).not.toHaveBeenCalled();
    }
  );

  it("refuses an htmlPath over the HTML size cap before rendering", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"]);
    const htmlPath = join(allowed, "huge.html");
    await fs.writeFile(htmlPath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    await expect(
      host.documents.renderPdf({ htmlPath, outputPath: join(allowed, "huge.pdf") })
    ).rejects.toThrow(/^PAYLOAD_TOO_LARGE:/);
    expect(renderMock.render).not.toHaveBeenCalled();
  });

  it("refuses a third concurrent render from one plugin with RENDER_BUSY", async () => {
    const host = registerPlugin(["fs:project-write"]);
    const finish: Array<() => void> = [];
    renderMock.render.mockImplementation(
      () => new Promise<Buffer>((resolve) => finish.push(() => resolve(PDF_BYTES)))
    );
    const call = (name: string) =>
      host.documents.renderPdf({ html: "<p/>", outputPath: join(allowed, name) });
    const first = call("1.pdf");
    const second = call("2.pdf");
    await expect(call("3.pdf")).rejects.toThrow(/^RENDER_BUSY:/);
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    for (const done of finish) done();
    await Promise.all([first, second]);
    // Slots are released once a call settles, whatever the outcome.
    renderMock.render.mockResolvedValue(PDF_BYTES);
    await expect(call("4.pdf")).resolves.toMatchObject({ path: join(allowed, "4.pdf") });
  });

  it("cancels an in-flight render when the plugin unloads", async () => {
    const host = registerPlugin(["fs:project-write"]);
    let signal: AbortSignal | undefined;
    renderMock.render.mockImplementation(
      (request: { signal: AbortSignal }) =>
        new Promise<Buffer>((_resolve, reject) => {
          signal = request.signal;
          signal.addEventListener("abort", () => reject(new Error("RENDER_CANCELLED: x")));
        })
    );
    const outputPath = join(allowed, "gone.pdf");
    const pending = host.documents.renderPdf({ html: "<p/>", outputPath });
    await vi.waitFor(() => expect(signal).toBeDefined());
    svc.unloadPlugin("acme.docs");
    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow(/^RENDER_CANCELLED:/);
    await expect(fs.stat(outputPath)).rejects.toThrow();
  });

  it("parks calls on an unanswered consent prompt without holding render slots", async () => {
    let answer: (value: "approved-once") => void = () => undefined;
    const prompt = new Promise<"approved-once">((resolve) => {
      answer = resolve;
    });
    getPluginCapabilityConsentService().setConsentBridge(() => prompt);
    const host = registerPlugin(["fs:project-write"]);
    const call = (name: string) =>
      host.documents.renderPdf({ html: "<p/>", outputPath: join(allowed, name) });
    const parked = [call("1.pdf"), call("2.pdf")];
    // A third call waiting on the same prompt is refused rather than queued.
    await expect(call("3.pdf")).rejects.toThrow(/^RENDER_BUSY: .*consent prompt/);
    // Every render slot is still free for other plugins while the prompt waits.
    const slots = Array.from({ length: MAX_OUTSTANDING_RENDERS }, (_v, i) =>
      reserveRender(`other-${Math.floor(i / 2)}`)
    );
    for (const slot of slots) slot.release();
    expect(renderMock.render).not.toHaveBeenCalled();

    answer("approved-once");
    await expect(Promise.all(parked)).resolves.toHaveLength(2);
  });

  it("times out from the moment the render slot is taken, whatever the render does", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const host = registerPlugin(["fs:project-write"]);
      let started = false;
      renderMock.render.mockImplementation((request: { timeoutMs: number }) => {
        started = true;
        expect(request.timeoutMs).toBeGreaterThan(0);
        expect(request.timeoutMs).toBeLessThanOrEqual(30_000);
        // A render that ignores its own timeout still cannot outlive the slot.
        return new Promise<Buffer>(() => {});
      });
      const pending = host.documents.renderPdf({
        html: "<p/>",
        outputPath: join(allowed, "slow.pdf"),
      });
      pending.catch(() => undefined);
      while (!started) await new Promise((resolve) => setImmediate(resolve));
      vi.advanceTimersByTime(30_000);
      await expect(pending).rejects.toThrow(/^RENDER_TIMEOUT:/);
      // The slot was released: the plugin can render again.
      renderMock.render.mockResolvedValue(PDF_BYTES);
      vi.useRealTimers();
      await expect(
        host.documents.renderPdf({ html: "<p/>", outputPath: join(allowed, "next.pdf") })
      ).resolves.toMatchObject({ path: join(allowed, "next.pdf") });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not create the data dir before consent, or ever when consent is denied", async () => {
    getPluginCapabilityConsentService().setConsentBridge(async () => {
      await expect(fs.stat(dataDir())).rejects.toThrow();
      return "rejected";
    });
    const host = registerPlugin(["fs:user-data-write"], []);
    await expect(
      host.documents.renderPdf({ html: "<p/>", outputPath: join(dataDir(), "q.pdf") })
    ).rejects.toThrow(/PERMISSION_REQUIRED/);
    await expect(fs.stat(dataDir())).rejects.toThrow();
  });

  it("refuses a nested output in a data dir that does not exist yet, without creating it", async () => {
    const host = registerPlugin(["fs:user-data-write"], []);
    await expect(
      host.documents.renderPdf({ html: "<p/>", outputPath: join(dataDir(), "sub", "q.pdf") })
    ).rejects.toThrow(/INVALID_PATH: .*parent directory does not exist/);
    await expect(fs.stat(dataDir())).rejects.toThrow();
    expect(renderMock.render).not.toHaveBeenCalled();
  });
});
