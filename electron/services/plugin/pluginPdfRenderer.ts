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

/** Cap on HTML a render holds in main, inline or read from `htmlPath`. */
export const MAX_HTML_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** Cumulative `file:` subresource bytes one render may load. */
export const MAX_RESOURCE_BYTES = 100 * 1024 * 1024;
/** Covers the queue wait as well as the render, so a queued job cannot sit forever. */
export const RENDER_TIMEOUT_MS = 30_000;
export const MAX_OUTSTANDING_RENDERS = 8;
export const MAX_OUTSTANDING_RENDERS_PER_OWNER = 2;
const CLEANUP_TIMEOUT_MS = 5_000;
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
    if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
      fail(`html exceeds the ${MAX_HTML_BYTES} byte limit; move large assets into files`);
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
  /** Cumulative bytes of `file:` subresources to admit; defaults to {@link MAX_RESOURCE_BYTES}. */
  maxResourceBytes?: number;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

// `//server/share` and `\\server\share`, plus the `\\?\` and `\\.\` device
// forms — every spelling that reaches a network path on Windows.
function isNetworkPath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

/**
 * Decide whether the render window may load `url`. Only `data:` and `file:`
 * ever pass: the page file itself, and files whose realpath sits inside the
 * resource root, up to a cumulative byte budget. Everything else — http(s),
 * ws, ftp, a file outside the root, a dangling path — is cancelled, which is
 * what keeps a rendered document from phoning home or pulling in a file the
 * plugin could not read itself.
 *
 * A `file:` URL naming a host (`file://server/share/x.png`) or any spelling of
 * a UNC path is refused before the filesystem is touched: on Windows even a
 * realpath of one opens an SMB connection and can hand the user's credentials
 * to whoever runs the server.
 *
 * The realpath is taken here and Chromium opens the path a moment later, so a
 * leaf swapped for a symlink in between is not caught. That grants nothing a
 * plugin's own unsandboxed `main` could not already do with `node:fs`.
 */
export function createDocumentRequestFilter(
  scope: DocumentRequestScope,
  io: {
    realpath: (p: string) => Promise<string>;
    size: (p: string) => Promise<number>;
  } = {
    realpath: fs.realpath,
    size: async (p) => (await fs.stat(p)).size,
  }
): (url: string) => Promise<boolean> {
  let budget = scope.maxResourceBytes ?? MAX_RESOURCE_BYTES;
  return async (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol === "data:") return true;
    if (parsed.protocol !== "file:") return false;
    if (parsed.host !== "" || isNetworkPath(parsed.pathname)) return false;
    let target: string;
    try {
      const local = fileURLToPath(parsed);
      if (isNetworkPath(local)) return false;
      target = await io.realpath(local);
    } catch {
      return false;
    }
    if (isNetworkPath(target)) return false;
    if (target === scope.mainFile) return true;
    if (scope.resourceRoot === null || !isInside(scope.resourceRoot, target)) return false;
    let bytes: number;
    try {
      bytes = await io.size(target);
    } catch {
      return false;
    }
    if (bytes > budget) return false;
    budget -= bytes;
    return true;
  };
}

// Resource hints Chromium acts on without a request the filter can see: a
// preconnect opens a socket and a dns-prefetch resolves a name straight from
// the network service. Electron has no per-session switch for either, so the
// snapshot loses every `<link>` that is not a stylesheet. The tag pattern
// skips quoted attribute values so a `>` inside one cannot end the match early.
const LINK_TAG = /<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const LINK_REL = /[\s/]rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const KEPT_REL_TOKENS: ReadonlySet<string> = new Set(["stylesheet", "alternate"]);
const DOCTYPE_PREFIX = /^\uFEFF?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype\b[^>]*>/i;

// Belt to the request filter's braces: remote loads are refused before a
// request exists, and a document that re-enables script finds nowhere to run it.
export const SNAPSHOT_CSP =
  "default-src 'none'; img-src file: data:; style-src 'unsafe-inline' file: data:; font-src file: data:";

function keepLinkTag(tag: string): boolean {
  const match = LINK_REL.exec(tag);
  if (!match) return true;
  const tokens = (match[1] ?? match[2] ?? match[3] ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return tokens.every((token) => KEPT_REL_TOKENS.has(token));
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The HTML the render window actually loads: the plugin's document with its
 * non-stylesheet `<link>` hints removed and a preamble placed first in the
 * head — UTF-8, the CSP, DNS prefetching off, and (for an `htmlPath` source) a
 * `<base>` pointing at the original directory so relative assets still resolve
 * there. The preamble goes after any doctype so standards mode is kept; the
 * parser hoists it into the head either way, and the first `<base>` wins.
 */
export function prepareSnapshotHtml(html: string, baseUrl: string | null): string {
  const preamble =
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(SNAPSHOT_CSP)}">` +
    `<meta http-equiv="x-dns-prefetch-control" content="off">` +
    (baseUrl === null ? "" : `<base href="${escapeAttribute(baseUrl)}">`);
  const stripped = html.replace(LINK_TAG, (tag) => (keepLinkTag(tag) ? tag : ""));
  const doctype = DOCTYPE_PREFIX.exec(stripped);
  if (!doctype) return preamble + stripped;
  return doctype[0] + preamble + stripped.slice(doctype[0].length);
}

// Electron never frees a session once created, so a fresh partition per render
// would leak a BrowserContext every call. A pair of in-memory partitions, each
// used by one render at a time and wiped after it, gives the same isolation
// and doubles as the concurrency cap. A partition whose wipe fails or hangs is
// retired for good and replaced under a new name, so leftover state from one
// render can never reach the next.
const PARTITION_PREFIX = "daintree-plugin-documents-";
const POOL_SIZE = 2;
let partitionGeneration = 0;
const freePartitions: string[] = [];
const partitionWaiters: Array<(partition: string) => void> = [];

function freshPartition(): string {
  return `${PARTITION_PREFIX}${partitionGeneration++}`;
}

function resetPool(): void {
  partitionGeneration = 0;
  freePartitions.splice(0, freePartitions.length);
  partitionWaiters.splice(0, partitionWaiters.length);
  for (let i = 0; i < POOL_SIZE; i++) freePartitions.push(freshPartition());
}
resetPool();

function acquirePartition(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const free = freePartitions.shift();
    if (free !== undefined) {
      resolve(free);
      return;
    }
    const onAbort = (): void => {
      const index = partitionWaiters.indexOf(grant);
      if (index >= 0) partitionWaiters.splice(index, 1);
      reject(signal.reason);
    };
    const grant = (partition: string): void => {
      signal.removeEventListener("abort", onAbort);
      resolve(partition);
    };
    partitionWaiters.push(grant);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function releasePartition(partition: string): void {
  const next = partitionWaiters.shift();
  if (next) next(partition);
  else freePartitions.push(partition);
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function wipeAndRelease(
  partition: string,
  ses: Electron.Session,
  timeoutMs: number
): Promise<void> {
  const wiped = await withTimeout(
    Promise.all([ses.clearStorageData(), ses.clearCache()]).then(
      () => true,
      () => false
    ),
    timeoutMs,
    false
  );
  releasePartition(wiped ? partition : freshPartition());
}

// Outstanding = queued + rendering. Counted from before the consent prompt so
// a plugin cannot park an unbounded number of HTML payloads in main.
let outstanding = 0;
const outstandingByOwner = new Map<string, number>();

export interface RenderReservation {
  readonly owner: string;
  release(): void;
}

/**
 * Claim one of the bounded render slots for `owner`, or reject with
 * `RENDER_BUSY:` when too many renders are already queued or running — across
 * all plugins, or for this one. Release it once the call is over.
 */
export function reserveRender(owner: string): RenderReservation {
  const mine = outstandingByOwner.get(owner) ?? 0;
  if (mine >= MAX_OUTSTANDING_RENDERS_PER_OWNER || outstanding >= MAX_OUTSTANDING_RENDERS) {
    throw renderError(
      "RENDER_BUSY",
      mine >= MAX_OUTSTANDING_RENDERS_PER_OWNER
        ? `plugin "${owner}" already has ${mine} renders in progress`
        : "too many renders are in progress; try again shortly"
    );
  }
  outstanding++;
  outstandingByOwner.set(owner, mine + 1);
  let released = false;
  return {
    owner,
    release() {
      if (released) return;
      released = true;
      outstanding--;
      const left = (outstandingByOwner.get(owner) ?? 1) - 1;
      if (left <= 0) outstandingByOwner.delete(owner);
      else outstandingByOwner.set(owner, left);
    },
  };
}

export interface RenderPdfRequest {
  /** The document, already read into memory; see {@link prepareSnapshotHtml}. */
  html: string;
  /** Directory URL relative references resolve against, or null for none. */
  baseUrl: string | null;
  /** See {@link DocumentRequestScope.resourceRoot}; must already be a realpath. */
  resourceRoot: string | null;
  print: Electron.PrintToPDFOptions;
  /** Aborting cancels a queued or running render with `RENDER_CANCELLED:`. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Bound on the session wipe after the render; a wipe past it retires the partition. */
  cleanupTimeoutMs?: number;
}

type RenderErrorCode =
  "RENDER_TIMEOUT" | "RENDER_FAILED" | "RENDER_BUSY" | "RENDER_CANCELLED" | "PAYLOAD_TOO_LARGE";

function renderError(code: RenderErrorCode, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * Render one HTML document to PDF bytes in a hidden, locked-down window. The
 * page is always a private snapshot written by this call — never a path the
 * plugin can swap — and the window, snapshot and session state never outlive
 * the call: success, failure, timeout and cancellation share one teardown.
 * The timeout starts when the call is made, so it bounds the queue wait too.
 */
export async function renderHtmlToPdf(request: RenderPdfRequest): Promise<Buffer> {
  const timeoutMs = request.timeoutMs ?? RENDER_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(renderError("RENDER_TIMEOUT", `render exceeded ${timeoutMs} ms`)),
    timeoutMs
  );
  const onCancel = (): void =>
    controller.abort(renderError("RENDER_CANCELLED", "the render was cancelled"));
  if (request.signal?.aborted) onCancel();
  else request.signal?.addEventListener("abort", onCancel, { once: true });
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(controller.signal.reason);
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => undefined);

  let partition: string;
  try {
    partition = await acquirePartition(controller.signal);
  } catch (error) {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onCancel);
    throw error;
  }
  const ses = session.fromPartition(partition);
  let win: BrowserWindow | null = null;
  let tempDir: string | null = null;
  try {
    // Teardown can run while this is still awaiting, so every step after an
    // await re-checks the abort before it creates anything teardown would miss
    // or touches a partition that may already belong to the next render.
    const stillWanted = (): void => {
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    const render = (async () => {
      // A file rather than a data: URL: Chromium caps navigation URLs at 2 MB,
      // and a file page goes through the same request filter as everything else.
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-pdf-"));
      if (controller.signal.aborted) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw controller.signal.reason;
      }
      tempDir = dir;
      const snapshot = path.join(dir, "document.html");
      await fs.writeFile(snapshot, prepareSnapshotHtml(request.html, request.baseUrl), {
        encoding: "utf-8",
        mode: 0o600,
      });
      const mainFile = await fs.realpath(snapshot);
      stillWanted();

      const allow = createDocumentRequestFilter({ mainFile, resourceRoot: request.resourceRoot });
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      ses.webRequest.onBeforeRequest((details, callback) => {
        allow(details.url).then(
          (ok) => callback({ cancel: !ok }),
          () => callback({ cancel: true })
        );
      });
      ses.on("will-download", preventDownload);

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
      try {
        await contents.loadURL(pathToFileURL(mainFile).href);
      } catch (error) {
        throw renderError(
          "RENDER_FAILED",
          `the document failed to load: ${formatErrorMessage(error, "unknown load error")}`
        );
      }
      stillWanted();
      const pdf = await contents.printToPDF(request.print);
      if (pdf.byteLength > MAX_PDF_BYTES) {
        throw renderError(
          "PAYLOAD_TOO_LARGE",
          `the rendered PDF exceeds the ${MAX_PDF_BYTES} byte limit`
        );
      }
      return pdf;
    })();
    // The loser of the race still settles after teardown; keep that quiet.
    render.catch(() => undefined);
    return await Promise.race([render, aborted]);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onCancel);
    const openWindow = win as BrowserWindow | null;
    if (openWindow && !openWindow.isDestroyed()) openWindow.destroy();
    ses.removeListener("will-download", preventDownload);
    ses.webRequest.onBeforeRequest(null);
    const dir = tempDir as string | null;
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await wipeAndRelease(partition, ses, request.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS);
  }
}

function preventDownload(event: Electron.Event): void {
  event.preventDefault();
}

/** @internal Test-only: restore the partition pool and render counters. */
export function _resetPdfRendererForTests(): void {
  resetPool();
  outstanding = 0;
  outstandingByOwner.clear();
}
