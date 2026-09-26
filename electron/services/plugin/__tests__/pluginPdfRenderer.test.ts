// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type BeforeRequestListener = (
  details: { url: string },
  callback: (response: { cancel: boolean }) => void
) => void;

type Listener = (...args: never[]) => unknown;
type PermissionHandler = (wc: unknown, permission: string, cb: (ok: boolean) => void) => void;

const electronMock = vi.hoisted(() => {
  const state = {
    loadURL: (_url: string): Promise<void> => Promise.resolve(),
    printToPDF: (_options: unknown): Promise<Buffer> => Promise.resolve(Buffer.from("%PDF-1.7")),
  };
  function makeSession(partition: string) {
    const listeners = new Map<string, Listener>();
    const ses = {
      partition,
      beforeRequest: null as BeforeRequestListener | null,
      webRequest: {
        onBeforeRequest(listener: BeforeRequestListener | null) {
          ses.beforeRequest = listener;
        },
      },
      setPermissionRequestHandler: vi.fn<(handler: PermissionHandler) => void>(),
      setPermissionCheckHandler: vi.fn(),
      clearStorageData: vi.fn(async () => {}),
      clearCache: vi.fn(async () => {}),
      on: vi.fn((event: string, fn: Listener) => listeners.set(event, fn)),
      removeListener: vi.fn((event: string) => listeners.delete(event)),
      listeners,
    };
    return ses;
  }
  const sessions = new Map<string, ReturnType<typeof makeSession>>();
  interface WindowOptions {
    show: boolean;
    webPreferences: Record<string, unknown> & { partition: string };
  }
  class FakeBrowserWindow {
    options: WindowOptions;
    destroyed = false;
    webContents;
    constructor(options: WindowOptions) {
      this.options = options;
      const handlers = new Map<string, (event: { preventDefault(): void }, url: string) => void>();
      this.webContents = {
        handlers,
        windowOpenHandler: null as null | (() => unknown),
        setWindowOpenHandler(fn: () => unknown) {
          this.windowOpenHandler = fn;
        },
        on(event: string, fn: (event: { preventDefault(): void }, url: string) => void) {
          handlers.set(event, fn);
        },
        loadURL: vi.fn((url: string) => state.loadURL(url)),
        printToPDF: vi.fn((opts: unknown) => state.printToPDF(opts)),
      };
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const windows: FakeBrowserWindow[] = [];
  return {
    sessions,
    windows,
    state,
    module: {
      BrowserWindow: FakeBrowserWindow,
      session: {
        fromPartition: vi.fn((partition: string) => {
          const existing = sessions.get(partition);
          if (existing) return existing;
          const created = makeSession(partition);
          sessions.set(partition, created);
          return created;
        }),
      },
    },
  };
});

vi.mock("electron", () => electronMock.module);

import {
  _resetPdfRendererForTests,
  createDocumentRequestFilter,
  renderHtmlToPdf,
  validateRenderPdfOptions,
} from "../pluginPdfRenderer.js";

let baseDir: string;

function sessionFor(partition: string) {
  const ses = electronMock.sessions.get(partition);
  if (!ses) throw new Error(`no session was created for ${partition}`);
  return ses;
}

beforeEach(() => {
  baseDir = realpathSync(mkdtempSync(join(tmpdir(), "plugin-pdf-")));
  electronMock.windows.length = 0;
  electronMock.sessions.clear();
  electronMock.state.loadURL = () => Promise.resolve();
  electronMock.state.printToPDF = () => Promise.resolve(Buffer.from("%PDF-1.7"));
  _resetPdfRendererForTests();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(baseDir, { recursive: true, force: true });
});

describe("validateRenderPdfOptions", () => {
  const ok = { html: "<p>x</p>", outputPath: "/tmp/out.pdf" };

  it("defaults to A4 with backgrounds and leaves CSS page size off", () => {
    expect(validateRenderPdfOptions("p", ok)).toEqual({
      source: { kind: "html", html: "<p>x</p>" },
      outputPath: "/tmp/out.pdf",
      print: { pageSize: "A4", printBackground: true, preferCSSPageSize: false },
    });
  });

  it("maps every supported option onto printToPDF", () => {
    const result = validateRenderPdfOptions("p", {
      htmlPath: "/tmp/in.html",
      outputPath: "/tmp/OUT.PDF",
      pageSize: "Letter",
      landscape: true,
      printBackground: false,
      margins: { top: 0, bottom: 3, left: 0.5 },
      pageRanges: " 1-3, 5 ",
    });
    expect(result.source).toEqual({ kind: "path", htmlPath: "/tmp/in.html" });
    expect(result.print).toEqual({
      pageSize: "Letter",
      landscape: true,
      printBackground: false,
      preferCSSPageSize: false,
      margins: { top: 0, bottom: 3, left: 0.5 },
      pageRanges: "1-3, 5",
    });
  });

  it.each([
    ["a non-object", null, /options must be an object/],
    ["an unknown key", { ...ok, margin: 1 }, /unknown option "margin"/],
    ["neither source", { outputPath: "/tmp/out.pdf" }, /exactly one of html or htmlPath/],
    ["both sources", { ...ok, htmlPath: "/tmp/in.html" }, /exactly one of html or htmlPath/],
    ["non-string html", { ...ok, html: 5 }, /html must be a string/],
    ["relative htmlPath", { htmlPath: "in.html", outputPath: "/tmp/o.pdf" }, /htmlPath must be/],
    ["relative outputPath", { ...ok, outputPath: "out.pdf" }, /outputPath must be an absolute/],
    ["non-pdf outputPath", { ...ok, outputPath: "/tmp/out.html" }, /must end in \.pdf/],
    ["an unknown page size", { ...ok, pageSize: "B5" }, /pageSize must be one of/],
    ["non-boolean landscape", { ...ok, landscape: "yes" }, /landscape must be a boolean/],
    ["non-boolean background", { ...ok, printBackground: 1 }, /printBackground must be/],
    ["non-object margins", { ...ok, margins: 1 }, /margins must be an object/],
    ["an unknown margin", { ...ok, margins: { middle: 1 } }, /unknown margin "middle"/],
    ["a negative margin", { ...ok, margins: { top: -0.1 } }, /margins.top must be/],
    ["an oversized margin", { ...ok, margins: { left: 3.5 } }, /margins.left must be/],
    ["a NaN margin", { ...ok, margins: { right: Number.NaN } }, /margins.right must be/],
    ["malformed pageRanges", { ...ok, pageRanges: "1-" }, /pageRanges must look like/],
    ["words in pageRanges", { ...ok, pageRanges: "all" }, /pageRanges must look like/],
    ["page zero", { ...ok, pageRanges: "0-2" }, /invalid range "0-2"/],
    ["a reversed range", { ...ok, pageRanges: "5-3" }, /invalid range "5-3"/],
  ])("refuses %s", (_label, raw, message) => {
    expect(() => validateRenderPdfOptions("acme", raw)).toThrow(/^VALIDATION: plugin "acme"/);
    expect(() => validateRenderPdfOptions("acme", raw)).toThrow(message);
  });

  it("refuses inline html over 5 MiB", () => {
    const html = "x".repeat(5 * 1024 * 1024 + 1);
    expect(() => validateRenderPdfOptions("p", { ...ok, html })).toThrow(/byte limit/);
  });
});

describe("createDocumentRequestFilter", () => {
  async function setup() {
    const root = join(baseDir, "root");
    await fs.mkdir(join(root, "assets"), { recursive: true });
    await fs.writeFile(join(root, "page.html"), "<p/>");
    await fs.writeFile(join(root, "assets", "logo.png"), "png");
    await fs.writeFile(join(baseDir, "secret.txt"), "secret");
    return { root, main: join(root, "page.html") };
  }

  it("allows data: URLs, the page itself and files inside the resource root", async () => {
    const { root, main } = await setup();
    const allow = createDocumentRequestFilter({ mainFile: main, resourceRoot: root });
    expect(await allow("data:image/png;base64,AAAA")).toBe(true);
    expect(await allow(pathToFileURL(main).href)).toBe(true);
    expect(await allow(pathToFileURL(join(root, "assets", "logo.png")).href)).toBe(true);
  });

  it.each([
    "https://example.com/logo.png",
    "http://127.0.0.1:8080/track",
    "ws://example.com/socket",
    "ftp://example.com/f",
    "blob:https://example.com/abc",
    "chrome://settings",
    "not a url",
  ])("cancels %s", async (url) => {
    const { root, main } = await setup();
    const allow = createDocumentRequestFilter({ mainFile: main, resourceRoot: root });
    expect(await allow(url)).toBe(false);
  });

  it("cancels a file outside the root, including through a symlink and a traversal", async () => {
    const { root, main } = await setup();
    await fs.symlink(join(baseDir, "secret.txt"), join(root, "assets", "link.txt"));
    const allow = createDocumentRequestFilter({ mainFile: main, resourceRoot: root });
    expect(await allow(pathToFileURL(join(baseDir, "secret.txt")).href)).toBe(false);
    expect(await allow(pathToFileURL(join(root, "assets", "link.txt")).href)).toBe(false);
    expect(await allow(`${pathToFileURL(root).href}/../secret.txt`)).toBe(false);
  });

  it("cancels a missing file rather than guessing where it would resolve", async () => {
    const { root, main } = await setup();
    const allow = createDocumentRequestFilter({ mainFile: main, resourceRoot: root });
    expect(await allow(pathToFileURL(join(root, "missing.png")).href)).toBe(false);
  });

  it("allows only the page when there is no resource root", async () => {
    const { main, root } = await setup();
    const allow = createDocumentRequestFilter({ mainFile: main, resourceRoot: null });
    expect(await allow(pathToFileURL(main).href)).toBe(true);
    expect(await allow(pathToFileURL(join(root, "assets", "logo.png")).href)).toBe(false);
    expect(await allow("data:text/plain,ok")).toBe(true);
  });
});

describe("renderHtmlToPdf", () => {
  const print = { pageSize: "A4" as const, printBackground: true };

  it("renders inline html in a hidden, locked-down window and tears it all down", async () => {
    const pdf = await renderHtmlToPdf({
      source: { kind: "html", html: "<h1>Invoice</h1>" },
      resourceRoot: null,
      print,
    });
    expect(pdf.toString()).toBe("%PDF-1.7");

    expect(electronMock.windows).toHaveLength(1);
    const win = electronMock.windows[0];
    expect(win.options.show).toBe(false);
    expect(win.options.webPreferences).toMatchObject({
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    });
    // An in-memory partition: no `persist:` prefix.
    expect(win.options.webPreferences.partition).not.toMatch(/^persist:/);
    expect(win.destroyed).toBe(true);

    // The page was loaded from a private temp file that no longer exists.
    const loaded = win.webContents.loadURL.mock.calls[0][0] as string;
    expect(loaded).toMatch(/^file:.*document\.html$/);
    await expect(fs.stat(new URL(loaded))).rejects.toThrow();

    expect(win.webContents.printToPDF).toHaveBeenCalledWith(print);
    expect(win.webContents.windowOpenHandler?.()).toEqual({ action: "deny" });
    const navigate = { preventDefault: vi.fn() };
    win.webContents.handlers.get("will-navigate")?.(navigate, "https://example.com");
    expect(navigate.preventDefault).toHaveBeenCalled();

    const ses = sessionFor(win.options.webPreferences.partition);
    expect(ses.beforeRequest).toBeNull();
    expect(ses.clearStorageData).toHaveBeenCalled();
    expect(ses.clearCache).toHaveBeenCalled();
    expect(ses.listeners.has("will-download")).toBe(false);
    const permission = vi.fn();
    ses.setPermissionRequestHandler.mock.calls[0][0](null, "media", permission);
    expect(permission).toHaveBeenCalledWith(false);
  });

  it("routes every request through the containment filter while the window is live", async () => {
    const root = join(baseDir, "root");
    await fs.mkdir(root);
    const page = join(root, "page.html");
    await fs.writeFile(page, "<p/>");
    const decisions: Array<[string, boolean]> = [];
    electronMock.state.loadURL = async (url) => {
      const ses = sessionFor(electronMock.windows[0].options.webPreferences.partition);
      for (const target of [url, "https://example.com/pixel.gif"]) {
        const cancel = await new Promise<boolean>((resolve) =>
          ses.beforeRequest?.({ url: target }, (r: { cancel: boolean }) => resolve(r.cancel))
        );
        decisions.push([target, !cancel]);
      }
    };
    await renderHtmlToPdf({ source: { kind: "file", file: page }, resourceRoot: root, print });
    expect(decisions).toEqual([
      [pathToFileURL(page).href, true],
      ["https://example.com/pixel.gif", false],
    ]);
  });

  it("rejects with RENDER_FAILED and still destroys the window when the page fails to load", async () => {
    electronMock.state.loadURL = () => Promise.reject(new Error("ERR_FILE_NOT_FOUND"));
    await expect(
      renderHtmlToPdf({ source: { kind: "html", html: "<p/>" }, resourceRoot: null, print })
    ).rejects.toThrow(/^RENDER_FAILED: .*ERR_FILE_NOT_FOUND/);
    expect(electronMock.windows[0].destroyed).toBe(true);
  });

  it("rejects with RENDER_TIMEOUT and destroys the window when printing hangs", async () => {
    electronMock.state.printToPDF = () => new Promise<Buffer>(() => {});
    await expect(
      renderHtmlToPdf({
        source: { kind: "html", html: "<p/>" },
        resourceRoot: null,
        print,
        timeoutMs: 20,
      })
    ).rejects.toThrow(/^RENDER_TIMEOUT:/);
    expect(electronMock.windows[0].destroyed).toBe(true);
  });

  it("runs at most two renders at once and hands a freed partition to the next", async () => {
    const pending: Array<(b: Buffer) => void> = [];
    electronMock.state.printToPDF = () => new Promise<Buffer>((resolve) => pending.push(resolve));
    const run = () =>
      renderHtmlToPdf({ source: { kind: "html", html: "<p/>" }, resourceRoot: null, print });
    const renders = [run(), run(), run()];
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(electronMock.windows).toHaveLength(2);
    const [first, second] = electronMock.windows.map((w) => w.options.webPreferences.partition);
    expect(first).not.toBe(second);

    pending[0](Buffer.from("%PDF-a"));
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect(electronMock.windows[2].options.webPreferences.partition).toBe(first);
    pending[1](Buffer.from("%PDF-b"));
    pending[2](Buffer.from("%PDF-c"));
    await Promise.all(renders);
    expect(electronMock.windows.every((w) => w.destroyed)).toBe(true);
  });
});
