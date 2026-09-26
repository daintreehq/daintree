import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { BrowserWindow, session } from "electron";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { PluginPdfPageSize, PluginRenderPdfOptions } from "../../../shared/types/plugin.js";

/**
 * HTML-to-PDF rendering behind `host.documents.renderPdf`. Everything here is
 * about the render: option validation, the hardened hidden window, and the
 * request filter. Path containment, capability gates, consent and the write
 * itself stay in `PluginHostFactory`, next to `host.fs.writeFile`, so the two
 * writers cannot drift apart.
 */

export const MAX_INLINE_HTML_BYTES = 5 * 1024 * 1024;
export const RENDER_TIMEOUT_MS = 30_000;
const MAX_MARGIN_INCHES = 3;
const MAX_PAGE_RANGES_LENGTH = 200;

const PAGE_SIZES: ReadonlySet<PluginPdfPageSize> = new Set([
  "A4",
  "Letter",
  "Legal",
  "A3",
  "A5",
  "Tabloid",
]);
const OPTION_KEYS: ReadonlySet<string> = new Set([
  "html",
  "htmlPath",
  "outputPath",
  "pageSize",
  "landscape",
  "printBackground",
  "margins",
  "pageRanges",
]);
const MARGIN_KEYS: ReadonlySet<string> = new Set(["top", "bottom", "left", "right"]);
const PAGE_RANGES_PATTERN = /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/;

export type PdfSource = { kind: "html"; html: string } | { kind: "path"; htmlPath: string };

export interface ValidatedRenderPdfOptions {
  source: PdfSource;
  outputPath: string;
  print: Electron.PrintToPDFOptions;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a plugin's `renderPdf` options and translate them to Electron's
 * `printToPDF` options. Strict by design: an unknown key is refused rather than
 * dropped, so a typo like `margin` fails loudly instead of printing with
 * defaults the author did not ask for.
 */
export function validateRenderPdfOptions(
  pluginId: string,
  raw: unknown
): ValidatedRenderPdfOptions {
  const fail = (message: string): never => {
    throw new Error(`VALIDATION: plugin "${pluginId}" documents.renderPdf: ${message}`);
  };
  if (!isPlainObject(raw)) fail("options must be an object");
  const options = raw as Record<string, unknown> & Partial<PluginRenderPdfOptions>;
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) fail(`unknown option "${key}"`);
  }

  const hasHtml = options.html !== undefined;
  const hasHtmlPath = options.htmlPath !== undefined;
  if (hasHtml === hasHtmlPath) fail("exactly one of html or htmlPath is required");
  let source: PdfSource;
  if (hasHtml) {
    if (typeof options.html !== "string") fail("html must be a string");
    const html = options.html as string;
    if (Buffer.byteLength(html, "utf8") > MAX_INLINE_HTML_BYTES) {
      fail(
        `html exceeds the ${MAX_INLINE_HTML_BYTES} byte limit; write it to a file and pass htmlPath`
      );
    }
    source = { kind: "html", html };
  } else {
    const htmlPath = options.htmlPath;
    if (typeof htmlPath !== "string" || !path.isAbsolute(htmlPath)) {
      fail("htmlPath must be an absolute path");
    }
    source = { kind: "path", htmlPath: htmlPath as string };
  }

  const outputPath = options.outputPath;
  if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
    fail("outputPath must be an absolute path");
  }
  if (!(outputPath as string).toLowerCase().endsWith(".pdf")) {
    fail("outputPath must end in .pdf");
  }

  const print: Electron.PrintToPDFOptions = {
    pageSize: "A4",
    printBackground: true,
    preferCSSPageSize: false,
  };
  if (options.pageSize !== undefined) {
    if (!PAGE_SIZES.has(options.pageSize as PluginPdfPageSize)) {
      fail(`pageSize must be one of ${[...PAGE_SIZES].join(", ")}`);
    }
    print.pageSize = options.pageSize;
  }
  if (options.landscape !== undefined) {
    if (typeof options.landscape !== "boolean") fail("landscape must be a boolean");
    print.landscape = options.landscape;
  }
  if (options.printBackground !== undefined) {
    if (typeof options.printBackground !== "boolean") fail("printBackground must be a boolean");
    print.printBackground = options.printBackground;
  }
  if (options.margins !== undefined) {
    if (!isPlainObject(options.margins)) fail("margins must be an object");
    const margins: Electron.PrintToPDFMargins = {};
    for (const [side, value] of Object.entries(options.margins as Record<string, unknown>)) {
      if (!MARGIN_KEYS.has(side)) fail(`unknown margin "${side}"`);
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > MAX_MARGIN_INCHES
      ) {
        fail(`margins.${side} must be a number of inches between 0 and ${MAX_MARGIN_INCHES}`);
      }
      margins[side as keyof Electron.PrintToPDFMargins] = value as number;
    }
    print.margins = margins;
  }
  if (options.pageRanges !== undefined) {
    const ranges = options.pageRanges;
    if (
      typeof ranges !== "string" ||
      ranges.length > MAX_PAGE_RANGES_LENGTH ||
      !PAGE_RANGES_PATTERN.test(ranges)
    ) {
      fail('pageRanges must look like "1-3, 5"');
    }
    for (const part of (ranges as string).split(",")) {
      const [start, end = start] = part.split("-").map((n) => Number(n.trim()));
      if (start < 1 || end < start) fail(`pageRanges has an invalid range "${part.trim()}"`);
    }
    print.pageRanges = (ranges as string).trim();
  }

  return { source, outputPath: outputPath as string, print };
}

export interface DocumentRequestScope {
  /** Realpath of the one HTML file the window is allowed to load as its page. */
  mainFile: string;
  /**
   * Realpath of the root that `file:` subresources must stay inside, or null
   * when the plugin may not read any root and so gets no local files at all.
   */
  resourceRoot: string | null;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/**
 * Decide whether the render window may load `url`. Only `data:` and `file:`
 * ever pass: the page file itself, and files whose realpath sits inside the
 * resource root. Everything else — http(s), ws, ftp, a file outside the root,
 * a dangling path — is cancelled, which is what keeps a rendered document from
 * phoning home or pulling in a file the plugin could not read itself.
 *
 * The realpath is taken here and Chromium opens the path a moment later, so a
 * leaf swapped for a symlink in between is not caught. That grants nothing a
 * plugin's own unsandboxed `main` could not already do with `node:fs`.
 */
export function createDocumentRequestFilter(
  scope: DocumentRequestScope,
  realpath: (p: string) => Promise<string> = fs.realpath
): (url: string) => Promise<boolean> {
  return async (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol === "data:") return true;
    if (parsed.protocol !== "file:") return false;
    let target: string;
    try {
      target = await realpath(fileURLToPath(parsed));
    } catch {
      return false;
    }
    if (target === scope.mainFile) return true;
    return scope.resourceRoot !== null && isInside(scope.resourceRoot, target);
  };
}

// Electron never frees a session once created, so a fresh partition per render
// would leak a BrowserContext every call. A fixed pair of in-memory partitions,
// each used by one render at a time and wiped after it, gives the same
// isolation and doubles as the global concurrency cap.
const PARTITIONS = ["daintree-plugin-documents-0", "daintree-plugin-documents-1"] as const;
const freePartitions: string[] = [...PARTITIONS];
const partitionWaiters: Array<(partition: string) => void> = [];

async function acquirePartition(): Promise<string> {
  const free = freePartitions.shift();
  if (free !== undefined) return free;
  return new Promise((resolve) => partitionWaiters.push(resolve));
}

function releasePartition(partition: string): void {
  const next = partitionWaiters.shift();
  if (next) next(partition);
  else freePartitions.push(partition);
}

export interface RenderPdfRequest {
  source: { kind: "html"; html: string } | { kind: "file"; file: string };
  /** See {@link DocumentRequestScope.resourceRoot}; must already be a realpath. */
  resourceRoot: string | null;
  print: Electron.PrintToPDFOptions;
  timeoutMs?: number;
}

function renderError(code: "RENDER_TIMEOUT" | "RENDER_FAILED", message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * Render one HTML document to PDF bytes in a hidden, locked-down window. The
 * window and its temp files never outlive the call: success, failure and
 * timeout all pass through the same teardown.
 */
export async function renderHtmlToPdf(request: RenderPdfRequest): Promise<Buffer> {
  const partition = await acquirePartition();
  const ses = session.fromPartition(partition);
  let win: BrowserWindow | null = null;
  let tempDir: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let mainFile: string;
    if (request.source.kind === "html") {
      // A file rather than a data: URL: Chromium caps navigation URLs at 2 MB,
      // and a file page goes through the same request filter as everything else.
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-pdf-"));
      mainFile = path.join(tempDir, "document.html");
      await fs.writeFile(mainFile, request.source.html, { encoding: "utf-8", mode: 0o600 });
    } else {
      mainFile = request.source.file;
    }
    mainFile = await fs.realpath(mainFile);

    const allow = createDocumentRequestFilter({ mainFile, resourceRoot: request.resourceRoot });
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest((details, callback) => {
      allow(details.url).then(
        (ok) => callback({ cancel: !ok }),
        () => callback({ cancel: true })
      );
    });

    win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        partition,
        javascript: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        plugins: false,
        spellcheck: false,
        devTools: false,
        navigateOnDragDrop: false,
        // A hidden window's renderer is otherwise throttled, which can stall
        // layout long enough to hit the timeout or print a blank page.
        backgroundThrottling: false,
      },
    });
    const contents = win.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    ses.on("will-download", preventDownload);

    const timeoutMs = request.timeoutMs ?? RENDER_TIMEOUT_MS;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(renderError("RENDER_TIMEOUT", `render exceeded ${timeoutMs} ms`)),
        timeoutMs
      );
    });
    const render = (async () => {
      try {
        await contents.loadURL(pathToFileURL(mainFile).href);
      } catch (error) {
        throw renderError(
          "RENDER_FAILED",
          `the document failed to load: ${formatErrorMessage(error, "unknown load error")}`
        );
      }
      return contents.printToPDF(request.print);
    })();
    // The loser of the race still settles after teardown; keep that quiet.
    render.catch(() => undefined);
    return await Promise.race([render, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (win && !win.isDestroyed()) win.destroy();
    ses.removeListener("will-download", preventDownload);
    ses.webRequest.onBeforeRequest(null);
    await ses.clearStorageData().catch(() => undefined);
    await ses.clearCache().catch(() => undefined);
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    releasePartition(partition);
  }
}

function preventDownload(event: Electron.Event): void {
  event.preventDefault();
}

/** @internal Test-only: restore the partition pool between tests. */
export function _resetPdfRendererForTests(): void {
  freePartitions.splice(0, freePartitions.length, ...PARTITIONS);
  partitionWaiters.splice(0, partitionWaiters.length);
}
