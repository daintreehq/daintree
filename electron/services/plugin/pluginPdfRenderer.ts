import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { BrowserWindow, session } from "electron";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

/**
 * HTML-to-PDF rendering behind `host.documents.renderPdf`. Everything here is
 * about the render: option validation, the hardened hidden window, and the
 * request filter. Path containment, capability gates, consent and the write
 * itself stay in `PluginHostFactory`, next to `host.fs.writeFile`, so the two
 * writers cannot drift apart.
 */

export const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** Cumulative `file:` subresource bytes one render may load. */
export const MAX_RESOURCE_BYTES = 100 * 1024 * 1024;
/** Covers the queue wait as well as the render, so a queued job cannot sit forever. */
export const RENDER_TIMEOUT_MS = 30_000;
export const MAX_OUTSTANDING_RENDERS = 8;
export const MAX_OUTSTANDING_RENDERS_PER_OWNER = 2;
export const MAX_AWAITING_CONSENT_PER_OWNER = 2;
const CLEANUP_TIMEOUT_MS = 5_000;

export {
  MAX_HTML_BYTES,
  validateRenderPdfOptions,
  type PdfSource,
  type ValidatedRenderPdfOptions,
} from "../../../shared/utils/pluginPdfOptions.js";

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
 * The byte budget is an admission check on each file's size at the moment it
 * is requested, not a bound on the bytes Chromium then reads: a file that
 * grows after the check delivers more. What it does refuse outright is
 * anything that is not a non-empty regular file — a FIFO, a device, or a
 * size-0 special like `/proc/*` whose real length `stat` cannot report.
 *
 * The realpath is taken here and Chromium opens the path a moment later, so a
 * leaf swapped for a symlink in between is not caught. That grants nothing a
 * plugin's own unsandboxed `main` could not already do with `node:fs`.
 */
export function createDocumentRequestFilter(
  scope: DocumentRequestScope,
  io: {
    realpath: (p: string) => Promise<string>;
    stat: (p: string) => Promise<{ isFile(): boolean; size: number }>;
  } = {
    realpath: fs.realpath,
    stat: (p) => fs.stat(p),
  }
): (url: string) => Promise<boolean> {
  let budget = scope.maxResourceBytes ?? MAX_RESOURCE_BYTES;
  // The snapshot is admitted once, as the document. Asked for again — as an
  // image with a fresh query string, say — it is one more resource and pays.
  let mainServed = false;
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
    const isMain = target === scope.mainFile;
    if (isMain && !mainServed) {
      mainServed = true;
      return true;
    }
    if (!isMain && (scope.resourceRoot === null || !isInside(scope.resourceRoot, target))) {
      return false;
    }
    let bytes: number;
    try {
      const stat = await io.stat(target);
      if (!stat.isFile() || stat.size === 0) return false;
      bytes = stat.size;
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
  // The parser decodes character references before Chromium reads `rel`, so
  // `pre&#99;onnect` is a preconnect: judge the decoded value. Only numeric
  // references and the two whitespace names can spell a rel token; anything
  // still carrying `&` after that is refused rather than guessed at.
  const decoded = decodeRelReferences(match[1] ?? match[2] ?? match[3] ?? "");
  if (decoded.includes("&")) return false;
  const tokens = decoded.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((token) => KEPT_REL_TOKENS.has(token));
}

function decodeRelReferences(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);?/g, (_, dec: string) => codePoint(parseInt(dec, 10)))
    .replace(/&Tab;/g, "\t")
    .replace(/&NewLine;/g, "\n");
}

function codePoint(n: number): string {
  // Out-of-range references decode to U+FFFD, which no kept token contains.
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�";
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

// Two separate bounds on calls parked in main, each holding its HTML:
//  - awaiting consent: per plugin only, and untimed — the prompt goes at the
//    user's pace, and one plugin's unanswered prompt must not hold a render
//    slot that other plugins are waiting for;
//  - outstanding (queued + rendering): per plugin and in total, and on the
//    clock from the moment the slot is taken.
let outstanding = 0;
const outstandingByOwner = new Map<string, number>();
const awaitingConsentByOwner = new Map<string, number>();

function releaseCount(counts: Map<string, number>, owner: string): void {
  const left = (counts.get(owner) ?? 1) - 1;
  if (left <= 0) counts.delete(owner);
  else counts.set(owner, left);
}

export interface ConsentWaitReservation {
  release(): void;
}

/**
 * Admit one more call from `owner` to wait on the consent prompt, or reject
 * with `RENDER_BUSY:` when it already has the maximum waiting. Holds no render
 * slot and starts no clock.
 */
export function reserveConsentWait(owner: string): ConsentWaitReservation {
  const mine = awaitingConsentByOwner.get(owner) ?? 0;
  if (mine >= MAX_AWAITING_CONSENT_PER_OWNER) {
    throw renderError(
      "RENDER_BUSY",
      `plugin "${owner}" already has ${mine} renders waiting on the consent prompt`
    );
  }
  awaitingConsentByOwner.set(owner, mine + 1);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      releaseCount(awaitingConsentByOwner, owner);
    },
  };
}

export interface RenderReservation {
  readonly owner: string;
  /** Rejects with `RENDER_TIMEOUT:` once the deadline passes; never resolves. */
  readonly expired: Promise<never>;
  /** Milliseconds left before the deadline, never below zero. */
  remainingMs(): number;
  release(): void;
}

/**
 * Claim one of the bounded render slots for `owner`, or reject with
 * `RENDER_BUSY:` when too many renders are already queued or running — across
 * all plugins, or for this one. The deadline starts here and covers everything
 * the slot is held for: reading the input, the queue wait and the render.
 * Release it once the call is over.
 */
export function reserveRender(owner: string, timeoutMs = RENDER_TIMEOUT_MS): RenderReservation {
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
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(renderError("RENDER_TIMEOUT", `render did not finish within ${timeoutMs} ms`)),
      timeoutMs
    );
  });
  expired.catch(() => undefined);
  let released = false;
  return {
    owner,
    expired,
    remainingMs: () => Math.max(0, deadline - Date.now()),
    release() {
      if (released) return;
      released = true;
      clearTimeout(timer);
      outstanding--;
      releaseCount(outstandingByOwner, owner);
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
  /** Time left for this call; the host passes what remains of its reservation. */
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
 * `timeoutMs` runs from the moment of the call, so it bounds the queue wait
 * too; the host passes what is left of the deadline its reservation started.
 */
export async function renderHtmlToPdf(request: RenderPdfRequest): Promise<Buffer> {
  const timeoutMs = request.timeoutMs ?? RENDER_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(renderError("RENDER_TIMEOUT", "the render did not finish in time")),
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
      let pdf: Buffer;
      try {
        pdf = await contents.printToPDF(request.print);
      } catch (error) {
        // Electron rejects with bare Chromium messages; give them the same
        // code as a failed load so callers have one prefix to match.
        throw renderError(
          "RENDER_FAILED",
          `printing failed: ${formatErrorMessage(error, "unknown print error")}`
        );
      }
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
  awaitingConsentByOwner.clear();
}
