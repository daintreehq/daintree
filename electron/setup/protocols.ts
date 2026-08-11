// eager-import-allow: sets up custom protocols (daintree, plugin) and security headers (CSP) eagerly on startup
import { app, protocol, session } from "electron";
import { getWindowForWebContents, getAppWebContents } from "../window/webContentsRegistry.js";
import path from "path";
import fs from "fs/promises";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import {
  resolveAppUrlToDistPath,
  getMimeType,
  buildHeaders,
  isImmutableAppAsset,
  isNotModified,
  setAppPermissionsPolicy,
  toHttpDate,
} from "../utils/appProtocol.js";
import {
  DAINTREE_APP_PERMISSIONS_POLICY,
  buildAppPermissionsPolicy,
} from "../../shared/config/permissionsPolicy.js";
import { getDevServerOrigins } from "../../shared/config/devServer.js";
import {
  classifyPartition,
  getDaintreeAppCSP,
  getLocalhostDevCSP,
  mergeCspHeaders,
  isDevPreviewPartition,
} from "../utils/webviewCsp.js";
import { resolveHtmlPreviewRoot } from "./htmlPreviewTokens.js";
import { canOpenExternalUrl, openExternalUrl } from "../utils/openExternal.js";
import {
  isLocalhostUrl,
  isDevPreviewProxyUrl,
  isSafeNavigationUrl,
} from "../../shared/utils/urlUtils.js";
import { isBrowserPartition } from "../../shared/utils/partitionUtils.js";
import { stripPluginViewGeneration } from "../../shared/utils/pluginViewUrl.js";
import { getWebviewDialogService } from "../services/WebviewDialogService.js";
import { looksLikeOAuthUrl } from "../services/OAuthLoopbackService.js";
import { CHANNELS } from "../ipc/channels.js";
import { logWarn } from "../utils/logger.js";

export type GetPluginDir = (pluginId: string) => string | undefined;

// Track which sessions have had protocols registered to avoid double-registration
const registeredSessions = new WeakSet<Electron.Session>();
let cachedDistPath: string | null = null;
let cachedGetPluginDir: GetPluginDir | null = null;

/**
 * Create the app:// protocol handler function for a given distPath.
 */
/**
 * Which read stage produced a 404. Every app:// URL is an application-owned
 * dist asset, so a miss always means the packaged tree is damaged or
 * unreadable — never a routine lookup. It matters because losing index.html
 * this way still commits a document that fires did-finish-load and carries the
 * preload (#11635), and the stage is the only thing that tells the otherwise
 * identical branches apart in a production log.
 */
type AppNotFoundStage = "resolve" | "stat" | "not-a-file" | "read";

function appNotFound(
  stage: AppNotFoundStage,
  url: string,
  filePath?: string,
  cause?: unknown
): Response {
  const errno = cause as NodeJS.ErrnoException | undefined;
  logWarn("app.protocol.not-found", {
    stage,
    url,
    ...(filePath ? { filePath } : {}),
    ...(typeof cause === "string" ? { reason: cause } : {}),
    ...(errno?.code ? { code: errno.code } : {}),
    ...(errno?.errno !== undefined ? { errno: errno.errno } : {}),
    // The path the failing syscall itself reported, kept alongside the
    // handler-resolved filePath: when the two disagree the report names the
    // layer that rewrote it, which is the only way to tell a damaged dist tree
    // apart from a packaging indirection failing underneath us (#11726).
    ...(errno?.path !== undefined ? { path: errno.path } : {}),
    ...(errno?.syscall !== undefined ? { syscall: errno.syscall } : {}),
  });
  return new Response("Not Found", {
    status: 404,
    headers: buildHeaders("text/plain"),
  });
}

function createAppProtocolHandler(distPath: string) {
  return async (request: GlobalRequest) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: buildHeaders("text/plain"),
      });
    }

    const { filePath, error } = resolveAppUrlToDistPath(request.url, distPath, {
      expectedHostname: "daintree",
    });

    if (error || !filePath) {
      return appNotFound("resolve", request.url, undefined, error);
    }

    // V8 code cache in Chromium 146 won't persist bytecode without both a
    // non-`no-store` Cache-Control AND a validator header. We stat the file
    // first so the validator and the 304 shortcut are both available — without
    // the 304 path every reload returns a fresh 200 that invalidates the
    // bytecode entry. See issue #8624.
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(filePath);
    } catch (err) {
      return appNotFound("stat", request.url, filePath, err);
    }

    // stat() succeeds on directories, so guard before the 304 short-circuit:
    // without this a directory URL carrying If-Modified-Since would return 304
    // instead of falling through to the open/read 404 path.
    if (!stats.isFile()) {
      return appNotFound("not-a-file", request.url, filePath);
    }

    const ifModifiedSince = request.headers.get("If-Modified-Since");
    if (isNotModified(ifModifiedSince, stats.mtime)) {
      return new Response(null, {
        status: 304,
        headers: buildHeaders(getMimeType(filePath), { stats, filePath }),
      });
    }

    // Read the bytes directly off disk instead of round-tripping through
    // net.fetch(). Custom-scheme responses never enter Chromium's HTTP disk
    // cache, so the fetch path added a Chromium network-stack hop plus a second
    // in-memory copy on every asset load for no caching benefit.
    //
    // This must stay fs.readFile, never fs.open: dist/ ships inside the asar
    // (it is deliberately not in asarUnpack), and Electron backs fs.open on an
    // archived path with Archive::CopyFileOut — an extraction to a temp file
    // memoized in external_files_ for callers that need a real fd. If that temp
    // file is reaped out from under a long-running app, the memoized entry goes
    // stale and every later open throws ENOENT while stat keeps succeeding off
    // the archive header, so index.html stops loading until restart and every
    // project switch fails (#11726). fs.readFile is patched separately to read
    // straight off the archive's own backing fd and never extracts.
    //
    // No O_NOFOLLOW to reach for either: unlike daintree-file:// / plugin://,
    // resolveAppUrlToDistPath does lexical (path.resolve + startsWith)
    // containment with no realpath, so there is no realpath/open TOCTOU window
    // for the flag to close — adding it would imply a defense that isn't set up
    // here. dist assets are application-owned.
    try {
      const buffer = await fs.readFile(filePath);
      return new Response(buffer, {
        status: 200,
        headers: buildHeaders(getMimeType(filePath), { stats, filePath }),
      });
    } catch (err) {
      // A directory that slipped past the isFile() guard surfaces as EISDIR;
      // map it and a vanished file to 404 so neither returns a 500.
      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT" || errCode === "EISDIR") {
        return appNotFound("read", request.url, filePath, err);
      }
      console.error("[MAIN] Error serving file:", filePath, err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: buildHeaders("text/plain"),
      });
    }
  };
}

// Parity with the files:read IPC handler (electron/ipc/handlers/files.ts).
// Files larger than this are rejected with 413 before any read, preventing
// renderer OOM via a malicious or accidental large-file URL.
const DAINTREE_FILE_MAX_BYTES = 512 * 1024;

// Raster images are decoded as pixels by the <img> element, not turned into a
// giant JS string the way a text read is, so the 512 KB text cap doesn't apply —
// a normal screenshot or AI-generated PNG routinely runs to several MB. These
// MIME types get a much larger ceiling (still bounded, and enforced against the
// bytes actually read) so the inline file viewer can display them. The set
// mirrors filePreviewKinds' IMAGE_EXTENSIONS; SVG is deliberately excluded — the
// viewer routes SVG through the sanitizing files:read path (its own 512 KB cap),
// so serving multi-MB raw SVG here would be inconsistent and pointless.
const DAINTREE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const LARGE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  // Animated PNG frames are stored close to raw, so an APNG clears 512 KB far
  // sooner than a still image of the same dimensions. Not a new exposure: the
  // same bytes already got this ceiling whenever they were named .png.
  "image/apng",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
]);

// PDFium renders from a single buffered response (no Range/206 needed —
// verified against Electron 42 / Chromium 148), so the whole document is held
// in memory across the Node buffer, the Response, and the viewer. 50 MB is
// double the raster-image allowance: enough for the specs, datasheets and
// design exports repos actually carry, while still bounding a single preview.
const DAINTREE_PDF_MAX_BYTES = 50 * 1024 * 1024;

function isPdfPath(filePath: string): boolean {
  return /\.pdf$/i.test(filePath);
}

/**
 * Which scheme is doing the read — selects the size ceiling and any gate the
 * canonical path must pass.
 *
 * `file`  daintree-file://, the viewer path that opts into the raster-image cap.
 * `asset` daintree-html:// sibling assets — the tight cap, so a script-driven
 *         preview can't turn the image allowance into an aggregate-memory DoS.
 * `pdf`   daintree-pdf://, capped separately and restricted to real PDFs.
 */
type DaintreeReadKind = "file" | "asset" | "pdf";

// The size ceiling for a resolved file, chosen from its canonical path.
function maxBytesForFile(realFile: string, kind: DaintreeReadKind): number {
  if (kind === "pdf") return DAINTREE_PDF_MAX_BYTES;
  return kind === "file" && LARGE_IMAGE_MIME_TYPES.has(getMimeType(realFile))
    ? DAINTREE_IMAGE_MAX_BYTES
    : DAINTREE_FILE_MAX_BYTES;
}

// Hardened response headers for daintree-file://.
// CORP must be cross-origin: the app:// renderer and daintree-file:// are
// different schemes (and therefore different origins/sites), and same-origin
// would block legitimate sub-resource loads. CSP sandbox neutralizes polyglot
// HTML/SVG payloads regardless of declared MIME. nosniff hardens against
// MIME-confusion. no-store reflects that disk files can change at any time
// and the handler has no ETag/Last-Modified infrastructure.
function buildDaintreeFileHeaders(mimeType: string, contentLength: number): Record<string, string> {
  return {
    "Content-Type": mimeType,
    "Content-Length": String(contentLength),
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

function buildDaintreeFileErrorHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/plain",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

// Media is streamed, not buffered, so the whole-file caps above don't apply —
// no response ever holds more than a stream chunk in memory (the caps exist to
// bound buffered bytes reaching the renderer, a model that doesn't fit ranged
// streaming; see maxBytesForFile). Every range form is served exactly as
// requested, to EOF for `bytes=N-`. Chromium treats a custom-scheme media load
// as single-shot: a 206 shorter than the requested range is taken as the whole
// resource and never re-requested (unlike http(s), where the multibuffer loader
// issues follow-up ranges), so a server-side chunk clamp truncates playback at
// the clamp — verified against Electron 42 / Chromium 148. Backpressure on the
// response stream keeps main-process memory chunk-bounded regardless of size.
// Audio rides the same path as video: a 4 MB podcast episode would 413 against
// the 512 KB buffered cap, and the renderer plays both through the same
// fetch-to-blob flow (#11425).
function isMediaMimeType(mimeType: string): boolean {
  return mimeType.startsWith("video/") || mimeType.startsWith("audio/");
}

type ParsedByteRange = { start: number; end: number } | "unsatisfiable" | null;

/**
 * Parse a single-range `Range: bytes=…` header against a known file size.
 * Null means "serve the whole file as 200": header absent, non-bytes unit,
 * syntactically malformed, multi-range, or inverted — RFC 9110 permits
 * ignoring all of these, and Chromium's media elements only send single ranges.
 * "unsatisfiable" means a well-formed range no byte can satisfy (416).
 */
function parseByteRange(rangeHeader: string | null, size: number): ParsedByteRange {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (startRaw === "" && endRaw === "") return null;

  if (startRaw === "") {
    // Suffix form `bytes=-N`: the last N bytes. An unsafe-integer N is beyond
    // any real file, so it degrades to "the whole file" rather than an error.
    if (size === 0) return "unsatisfiable";
    const suffix = Number(endRaw);
    if (suffix === 0) return "unsatisfiable";
    const start = Number.isSafeInteger(suffix) ? Math.max(0, size - suffix) : 0;
    return { start, end: size - 1 };
  }

  const start = Number(startRaw);
  // A digits-only start past the safe-integer range is beyond any real file's
  // EOF — unsatisfiable, not ignorable (ignoring would serve the whole file).
  if (!Number.isSafeInteger(start)) return "unsatisfiable";
  const end = endRaw === "" ? null : Number(endRaw);
  // Inverted ranges are invalid range specs per RFC 9110 → ignore the header,
  // whatever the file size.
  if (end !== null && Number.isSafeInteger(end) && end < start) return null;
  if (size === 0 || start >= size) return "unsatisfiable";
  // An unsafe-integer or past-EOF end clamps to EOF per RFC.
  return {
    start,
    end: end !== null && Number.isSafeInteger(end) ? Math.min(end, size - 1) : size - 1,
  };
}

/**
 * Serve an already-containment-checked media file as a Range-aware stream.
 *
 * Bypasses readContainedDaintreeFile's buffer-and-cap core deliberately:
 * media seeks via byte ranges and a multi-hundred-MB recording must never be
 * read whole. The open-and-stream flow keeps the same TOCTOU discipline as
 * diffMedia.ts's readWorkingSide — O_NOFOLLOW rejects a final-component
 * symlink swap after the realpath check, O_NONBLOCK (no-op on Windows) keeps a
 * FIFO swapped in its place from wedging the open, and the post-open fd-level
 * stat rejects anything that isn't a regular file. Range bounds derive from
 * that fd stat, so they describe the exact file that was opened.
 */
async function streamContainedMediaFile(
  normalizedFile: string,
  mimeType: string,
  request: GlobalRequest
): Promise<Response> {
  let fileHandle: Awaited<ReturnType<typeof fs.open>>;
  try {
    fileHandle = await fs.open(
      normalizedFile,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)
    );
  } catch (err) {
    const errCode = (err as NodeJS.ErrnoException).code;
    if (errCode === "ELOOP" || errCode === "ENOENT") {
      return new Response("Not Found", {
        status: 404,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
    throw err;
  }

  let size: number;
  try {
    const fdStat = await fileHandle.stat();
    // The fd-level stat rejects both type swaps (FIFO) and sizes that break
    // JS integer arithmetic (a sparse file can exceed 2^53 bytes; stream
    // start/end and Content-Range math would silently corrupt).
    if (!fdStat.isFile() || !Number.isSafeInteger(fdStat.size)) {
      await fileHandle.close().catch(() => {});
      return new Response("Not Found", {
        status: 404,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
    size = fdStat.size;
  } catch (err) {
    await fileHandle.close().catch(() => {});
    throw err;
  }

  // HEAD ignores Range by definition (RFC 9110 defines range handling for GET
  // only). Chromium probes with HEAD before issuing ranged GETs; answer with
  // the metadata (and Accept-Ranges, so seeking is offered) without a read.
  if (request.method === "HEAD") {
    await fileHandle.close().catch(() => {});
    return new Response(null, {
      status: 200,
      headers: {
        ...buildDaintreeFileHeaders(mimeType, size),
        "Accept-Ranges": "bytes",
      },
    });
  }

  const range = parseByteRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    await fileHandle.close().catch(() => {});
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: {
        ...buildDaintreeFileErrorHeaders(),
        "Content-Range": `bytes */${size}`,
      },
    });
  }

  if (size === 0) {
    await fileHandle.close().catch(() => {});
    return new Response(null, {
      status: 200,
      headers: {
        ...buildDaintreeFileHeaders(mimeType, 0),
        "Accept-Ranges": "bytes",
      },
    });
  }

  // Serve the requested range in full — never a shorter chunk. Chromium's
  // custom-scheme media loader is single-shot: it treats a response body that
  // ends before the requested range as the entire resource (the Content-Range
  // total is not consulted for a re-request), so a truncated 206 silently cuts
  // the video off at the truncation point (#11382 follow-up).
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const contentLength = end - start + 1;

  // autoClose ties the fd's lifetime to the stream: it closes on end, error,
  // and destroy — including the destroy toWeb() issues when the renderer
  // cancels the response body (pane closed, seek abandoned mid-request).
  // Until that handoff succeeds, the fd is still ours to close.
  let body: ReadableStream;
  let nodeStream: ReturnType<typeof fileHandle.createReadStream> | undefined;
  try {
    nodeStream = fileHandle.createReadStream({ start, end, autoClose: true });
    body = Readable.toWeb(nodeStream) as unknown as ReadableStream;
  } catch (err) {
    nodeStream?.destroy();
    await fileHandle.close().catch(() => {});
    throw err;
  }

  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      ...buildDaintreeFileHeaders(mimeType, contentLength),
      "Accept-Ranges": "bytes",
      ...(range && { "Content-Range": `bytes ${start}-${end}/${size}` }),
    },
  });
}

/**
 * Realpath containment shared by the buffered read core and the video
 * streaming path: resolve symlinks before comparing so an in-root symlink
 * pointing outside root is rejected (CVE-2025-53109 / CVE-2025-54794 class).
 * Returns the canonical file path, or the 404 Response to relay.
 */
async function resolveContainedRealPath(
  normalizedRoot: string,
  normalizedFile: string
): Promise<{ realFile: string } | Response> {
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await fs.realpath(normalizedRoot);
    realFile = await fs.realpath(normalizedFile);
  } catch {
    return new Response("Not Found", {
      status: 404,
      headers: buildDaintreeFileErrorHeaders(),
    });
  }

  const rel = path.relative(realRoot, realFile);
  // Match exact ".." and "../*" — bare startsWith("..") would reject legitimate files like "..hidden/x". isAbsolute catches Windows cross-drive escapes.
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return new Response("Not Found", {
      status: 404,
      headers: buildDaintreeFileErrorHeaders(),
    });
  }

  return { realFile };
}

/**
 * Shared read core for daintree-file://, daintree-html:// and daintree-pdf://:
 * realpath containment, a size cap (per maxBytesForFile, selected by `kind`),
 * and O_RDONLY|O_NOFOLLOW open. Returns the file bytes plus the canonical path
 * (for MIME), or an error Response. Callers own the success headers so each
 * scheme sets its own CSP. The flow (realpath → path.relative → stat →
 * O_NOFOLLOW open) and its TOCTOU defenses are unchanged.
 */
// Return type is inferred, not annotated: annotating `buffer: Buffer` widens it
// to `Buffer<ArrayBufferLike>`, which `new Response(...)` rejects as a BodyInit.
// Inference preserves the exact `readFile()` result type the Response accepts.
async function readContainedDaintreeFile(
  normalizedRoot: string,
  normalizedFile: string,
  kind: DaintreeReadKind
) {
  const contained = await resolveContainedRealPath(normalizedRoot, normalizedFile);
  if (contained instanceof Response) return contained;
  const { realFile } = contained;

  // Gate on the CANONICAL path before any stat/open/read: routing on the
  // request path would let `report.pdf` → `huge.bin` be buffered under the
  // 50 MB PDF ceiling on Windows, where O_NOFOLLOW is a no-op. Rejecting here
  // means a non-PDF never gets read under the PDF allowance at all.
  if (kind === "pdf" && !isPdfPath(realFile)) {
    return new Response("Unsupported Media Type", {
      status: 415,
      headers: buildDaintreeFileErrorHeaders(),
    });
  }

  // Stat the realpath-resolved path for an accurate size before any read.
  let fileStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    fileStat = await fs.stat(realFile);
  } catch {
    return new Response("Not Found", {
      status: 404,
      headers: buildDaintreeFileErrorHeaders(),
    });
  }

  const maxBytes = maxBytesForFile(realFile, kind);
  if (fileStat.size > maxBytes) {
    return new Response("Payload Too Large", {
      status: 413,
      headers: buildDaintreeFileErrorHeaders(),
    });
  }

  // Open the user-supplied normalized path (not realFile) with O_NOFOLLOW
  // so a *final-component* symlink injected after the realpath check is
  // rejected with ELOOP — narrowing (not fully closing) the realpath→open
  // TOCTOU window; an intermediate-directory swap is still theoretically
  // possible and is an accepted limitation shared with files:read. On Windows
  // O_NOFOLLOW is 0 (no-op); realpath containment still applies.
  let fileHandle: Awaited<ReturnType<typeof fs.open>>;
  try {
    fileHandle = await fs.open(normalizedFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const errCode = (err as NodeJS.ErrnoException).code;
    if (errCode === "ELOOP" || errCode === "ENOENT") {
      return new Response("Not Found", {
        status: 404,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
    throw err;
  }

  try {
    const buffer = await fileHandle.readFile();
    // The pre-read stat is advisory: a writer can grow or swap the file between
    // stat and read (O_NOFOLLOW blocks only a final-component symlink swap, not
    // a regular-file replacement or in-place growth). Re-check the bytes we
    // actually read so an oversized file can never reach the renderer, where the
    // decode-OOM risk this cap exists to bound actually lives.
    if (buffer.length > maxBytes) {
      return new Response("Payload Too Large", {
        status: 413,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
    return { buffer, realFile };
  } finally {
    // Swallow close errors so they don't mask a preceding readFile failure.
    await fileHandle.close().catch(() => {});
  }
}

/**
 * The origin allowed to read this daintree-file:// response via cross-origin
 * fetch(), or null for everyone else. The scheme is corsEnabled so the file
 * viewer can fetch() media bytes for blob-URL playback, but eligibility alone
 * must not grant reads: a browser panel hosting an arbitrary remote site
 * shares the scheme registration, and echoing its origin here would hand it
 * the user's local files. Only the trusted app document qualifies — app:// in
 * production, the Vite dev-server origins in development. Tag loads (<img>,
 * <video>) are no-cors and never consult this.
 */
function daintreeFileCorsOrigin(request: GlobalRequest): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (origin === "app://daintree") return origin;
  // The dev-server allowance additionally requires an unpackaged build so a
  // packaged app launched with NODE_ENV=development in its environment can't
  // widen the trust set to localhost origins.
  if (
    !app.isPackaged &&
    process.env.NODE_ENV === "development" &&
    getDevServerOrigins().includes(origin)
  ) {
    return origin;
  }
  return null;
}

/**
 * Create the daintree-file:// protocol handler function.
 */
function createDaintreeFileProtocolHandler() {
  const handleRequest = createDaintreeFileRequestCore();
  return async (request: GlobalRequest) => {
    const response = await handleRequest(request);
    // Constructed Responses have mutable headers, so the CORS grant rides on
    // every path (success and error alike) — a blocked error response would
    // otherwise surface as an opaque TypeError instead of a readable status.
    const corsOrigin = daintreeFileCorsOrigin(request);
    if (corsOrigin) response.headers.set("Access-Control-Allow-Origin", corsOrigin);
    return response;
  };
}

/** The daintree-file:// request core, minus the CORS header pass. */
function createDaintreeFileRequestCore() {
  return async (request: GlobalRequest) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }

    try {
      const url = new URL(request.url);
      const filePath = url.searchParams.get("path");
      const rootPath = url.searchParams.get("root");

      if (!filePath || !rootPath) {
        return new Response("Missing path or root parameter", {
          status: 400,
          headers: buildDaintreeFileErrorHeaders(),
        });
      }

      if (filePath.includes("\0") || rootPath.includes("\0")) {
        return new Response("Invalid path", {
          status: 400,
          headers: buildDaintreeFileErrorHeaders(),
        });
      }

      if (!path.isAbsolute(filePath) || !path.isAbsolute(rootPath)) {
        return new Response("Paths must be absolute", {
          status: 400,
          headers: buildDaintreeFileErrorHeaders(),
        });
      }

      const normalizedRoot = path.normalize(rootPath);
      const normalizedFile = path.normalize(filePath);

      // Audio and video take the streaming path instead of the buffer-and-cap
      // core. Classification must come from the canonical path, not the request
      // path: on Windows O_NOFOLLOW is a no-op, so a final-component symlink
      // (`clip.mp4` → `notes.txt`) opens fine, and request-path routing would
      // stream a non-media file uncapped under a media MIME. On POSIX ELOOP
      // rejects that symlink at open, so the two spellings agree either way.
      if (isMediaMimeType(getMimeType(normalizedFile))) {
        const contained = await resolveContainedRealPath(normalizedRoot, normalizedFile);
        if (contained instanceof Response) return contained;
        const realMimeType = getMimeType(contained.realFile);
        if (isMediaMimeType(realMimeType)) {
          return await streamContainedMediaFile(normalizedFile, realMimeType, request);
        }
        // A media-suffixed alias of a non-media file — fall through to the
        // buffered path, which redoes containment and applies its usual caps.
      }

      const result = await readContainedDaintreeFile(normalizedRoot, normalizedFile, "file");
      if (result instanceof Response) return result;

      // Content-Length reflects the bytes actually returned. If the file
      // grew between stat() and readFile(), buffer.length is the truth.
      return new Response(result.buffer, {
        status: 200,
        headers: buildDaintreeFileHeaders(getMimeType(result.realFile), result.buffer.length),
      });
    } catch (err) {
      console.error("[MAIN] daintree-file protocol error:", err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
  };
}

/** True for any `daintree-html://…` request URL (the sandboxed preview scheme). */
function isDaintreeHtmlPreviewUrl(url: string | undefined): boolean {
  return typeof url === "string" && url.startsWith("daintree-html://");
}

/**
 * CSP for a `daintree-html://<token>` sandboxed preview *document* (.html/.htm).
 * Scoped to the exact token authority — NOT the whole `daintree-html:` scheme —
 * so a rendered report cannot tag-load through a different token's root. Only
 * navigable-document responses carry an enforced CSP (the browser ignores CSP
 * on sub-resource responses), so sibling css/js/img assets keep the strict leaf
 * headers.
 *
 * The iframe element also sets sandbox="allow-scripts" (opaque origin, no
 * allow-same-origin); the `sandbox allow-scripts` directive here is
 * defense-in-depth if that attribute is ever dropped. `connect-src 'none'`
 * blocks fetch/XHR/WebSocket back to the scheme; the document can still execute
 * its own scripts and tag-load its own assets. 'unsafe-inline'/'unsafe-eval'
 * are harmless inside a fully isolated, network-less opaque origin and let
 * real-world report/chart pages run.
 */
function buildDaintreeHtmlDocHeaders(token: string, contentLength: number): Record<string, string> {
  const self = `daintree-html://${token}`;
  const csp = [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${self} 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: blob:`,
    `font-src ${self} data:`,
    `media-src ${self} data: blob:`,
    "connect-src 'none'",
    // WebRTC is not covered by connect-src, so block it explicitly — otherwise a
    // rendered report could exfiltrate via an attacker-controlled STUN/TURN host.
    "webrtc 'block'",
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(contentLength),
    "Content-Security-Policy": csp,
    "Cross-Origin-Resource-Policy": "cross-origin",
    // The trusted renderer document is COEP `credentialless` (app:// headers +
    // vite dev server), and a COEP document may only embed frames whose own
    // document response carries a compatible COEP. Without this the iframe
    // navigation dies with ERR_BLOCKED_BY_RESPONSE — a blank white frame.
    "Cross-Origin-Embedder-Policy": "credentialless",
    "X-Content-Type-Options": "nosniff",
    // Belt-and-suspenders egress limits: no referrer leakage on any request the
    // page makes, and no speculative DNS lookups of hostnames in the markup.
    "Referrer-Policy": "no-referrer",
    "X-DNS-Prefetch-Control": "off",
    "Cache-Control": "no-store",
  };
}

/**
 * Create the daintree-html:// protocol handler — sandboxed HTML file preview
 * (issue #11191). URL shape: `daintree-html://<token>/<relative/path>`, where
 * <token> is an opaque capability minted by htmlPreviewTokens for exactly one
 * canonical root. Unknown/stale tokens 404 — a request never falls through to a
 * filesystem read without a registered root. Security mirrors daintree-file://:
 * segment `..` rejection, realpath containment, and O_RDONLY|O_NOFOLLOW on the
 * final open (via the shared read core).
 */
function createDaintreeHtmlProtocolHandler() {
  return async (request: GlobalRequest) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Bad Request", {
        status: 400,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }

    const token = url.hostname;
    const root = token ? resolveHtmlPreviewRoot(token) : undefined;
    if (!root) {
      // Unknown or released token — never fall back to a raw filesystem read.
      return new Response("Not Found", {
        status: 404,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }

    // Root-identity binding: the token maps to a canonical (realpath'd) root
    // captured at mint time. If that path no longer canonically resolves to
    // itself — e.g. the directory was renamed away and replaced with a symlink
    // to "/" — the token would otherwise retarget to a different subtree. Reject
    // it so a stale capability can't be deterministically repointed.
    try {
      if ((await fs.realpath(root)) !== root) {
        return new Response("Not Found", {
          status: 404,
          headers: buildDaintreeFileErrorHeaders(),
        });
      }
    } catch {
      return new Response("Not Found", {
        status: 404,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }

    // Decode the pathname segment-by-segment; ignore query/fragment so a
    // cache-busting `?v=N` on the iframe src still maps to the same file.
    const pathname = url.pathname;
    if (pathname === "/" || pathname === "") {
      return new Response("Not Found", {
        status: 404,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname.startsWith("/") ? pathname.slice(1) : pathname);
    } catch {
      return new Response("Bad Request", {
        status: 400,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
    if (decodedPath.includes("\0")) {
      return new Response("Bad Request", {
        status: 400,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
    if (decodedPath.includes("\\")) {
      return new Response("Not Found", {
        status: 404,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
    // Collapse `..` against a leading slash, then reject any residual `..`
    // segment. Defense-in-depth; realpath/path.relative containment in the
    // shared read core is the real traversal guard. #4702: segment match, not
    // substring includes('..').
    const normalizedPosix = path.posix.normalize("/" + decodedPath).slice(1);
    if (normalizedPosix === "" || normalizedPosix.split("/").some((seg) => seg === "..")) {
      return new Response("Not Found", {
        status: 404,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }

    try {
      const candidatePath = path.resolve(root, normalizedPosix);
      // Report assets keep the tight cap: a preview document can execute scripts
      // and request the same file many times, so the raster-image allowance is
      // scoped to the daintree-file:// viewer path only.
      const result = await readContainedDaintreeFile(path.normalize(root), candidatePath, "asset");
      if (result instanceof Response) return result;

      // Only navigable HTML documents get the loosened, token-scoped CSP;
      // sibling assets keep the strict leaf headers (sub-resource CSP is
      // unenforced by the browser anyway).
      const isHtmlDoc = /\.html?$/i.test(result.realFile);
      const headers = isHtmlDoc
        ? buildDaintreeHtmlDocHeaders(token, result.buffer.length)
        : buildDaintreeFileHeaders(getMimeType(result.realFile), result.buffer.length);
      return new Response(result.buffer, { status: 200, headers });
    } catch (err) {
      console.error("[MAIN] daintree-html protocol error:", err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
  };
}

/** True for any `daintree-pdf://…` request URL (the inline PDF preview scheme). */
function isDaintreePdfPreviewUrl(url: string | undefined): boolean {
  return typeof url === "string" && url.startsWith("daintree-pdf://");
}

/**
 * Preview documents whose protocol-handler response headers must survive the
 * session-wide CSP overlay untouched. Both schemes need the pass-through, for
 * opposite reasons:
 *   daintree-html:// carries a token-scoped CSP and a COEP that the overlay
 *     would replace with the trusted app policy.
 *   daintree-pdf:// carries NEITHER, and must not acquire either: a `sandbox`
 *     CSP blocks PDFium outright (ERR_BLOCKED_BY_CLIENT), and a COEP header
 *     makes the PDF document an embedder whose own internal viewer frame is
 *     then blocked (ERR_BLOCKED_BY_RESPONSE). Both verified against
 *     Electron 42 / Chromium 148.
 */
function shouldPreservePreviewResponseHeaders(url: string | undefined): boolean {
  return isDaintreeHtmlPreviewUrl(url) || isDaintreePdfPreviewUrl(url);
}

/**
 * `Content-Disposition` for a PDF response. The URL's own last segment is
 * `load`, so without an explicit filename PDFium's download button and title
 * would both use that. Ships a quoted ASCII fallback plus an RFC 5987
 * `filename*` so non-ASCII names survive.
 */
function buildPdfContentDisposition(realFile: string): string {
  const base = path.basename(realFile);
  // Drop everything outside printable ASCII (control chars, CR/LF) before
  // neutralizing the quote and backslash that would otherwise escape the
  // quoted-string.
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // encodeURIComponent leaves ' ( ) * unescaped, but RFC 8187 `attr-char`
  // excludes them, so a conforming parser would reject the extended value and
  // silently fall back to the lossy ASCII one.
  const encoded = encodeURIComponent(base).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Response headers for a daintree-pdf:// document.
 *
 * Content-Type is hard-coded, never derived from the path: the canonical-path
 * `.pdf` gate in the read core plus a fixed `application/pdf` here is what
 * makes the `frame-src daintree-pdf:` allowance safe — a repo file holding
 * active HTML under a `.pdf` name reaches PDFium as PDF bytes and fails as a
 * malformed document rather than executing.
 *
 * Deliberately absent: `Content-Security-Policy` (a `sandbox` policy blocks
 * PDFium) and `Cross-Origin-Embedder-Policy` (blocks PDFium's own viewer
 * frame). The iframe carries `credentialless` instead, which is what lets a
 * COEP-credentialless app shell embed a document that asserts no COEP at all.
 */
function buildDaintreePdfHeaders(realFile: string, contentLength: number): Record<string, string> {
  return {
    "Content-Type": "application/pdf",
    "Content-Length": String(contentLength),
    "Content-Disposition": buildPdfContentDisposition(realFile),
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

/**
 * Create the daintree-pdf:// protocol handler — inline PDF preview (#11427).
 * URL shape mirrors daintree-file://: `daintree-pdf://load?path=…&root=…`.
 *
 * Range headers are ignored: PDFium renders fine from a single buffered 200
 * with an accurate Content-Length, so there is no reason to carry the video
 * path's ranged-streaming machinery here.
 */
function createDaintreePdfProtocolHandler() {
  return async (request: GlobalRequest) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }

    try {
      const url = new URL(request.url);
      const filePath = url.searchParams.get("path");
      const rootPath = url.searchParams.get("root");

      if (!filePath || !rootPath) {
        return new Response("Missing path or root parameter", {
          status: 400,
          headers: buildDaintreeFileErrorHeaders(),
        });
      }

      if (filePath.includes("\0") || rootPath.includes("\0")) {
        return new Response("Invalid path", {
          status: 400,
          headers: buildDaintreeFileErrorHeaders(),
        });
      }

      if (!path.isAbsolute(filePath) || !path.isAbsolute(rootPath)) {
        return new Response("Paths must be absolute", {
          status: 400,
          headers: buildDaintreeFileErrorHeaders(),
        });
      }

      const result = await readContainedDaintreeFile(
        path.normalize(rootPath),
        path.normalize(filePath),
        "pdf"
      );
      if (result instanceof Response) return result;

      const headers = buildDaintreePdfHeaders(result.realFile, result.buffer.length);
      // HEAD answers with the metadata only. The bytes were already read to
      // size the response honestly, but attaching a body up to the PDF cap to
      // a request that discards it is pure waste.
      return new Response(request.method === "HEAD" ? null : result.buffer, {
        status: 200,
        headers,
      });
    } catch (err) {
      console.error("[MAIN] daintree-pdf protocol error:", err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
  };
}

const ONE_YEAR_SECONDS = 31_536_000;
const PLUGIN_IMMUTABLE_DIRECTIVE = `public, max-age=${ONE_YEAR_SECONDS}, immutable`;
const PLUGIN_REVALIDATE_DIRECTIVE = "no-cache";

// Hardened response headers for plugin://.
// CORP must be cross-origin: plugin assets may be loaded as sub-resources from
// documents under app://, daintree-file:// or a future plugin host frame. With
// same-origin, COEP-enabled embedders silently reject every plugin asset with
// ERR_BLOCKED_BY_RESPONSE. COEP is not set on individual sub-resources — the
// plugin view document is responsible for cross-origin isolation policy.
function buildPluginHeaders(
  mimeType: string,
  filePath: string,
  stats?: { mtime: Date }
): Record<string, string> {
  // Vite content-hashed assets (`assets/<name>-<hash>.<ext>`) are immutable;
  // everything else is `no-cache` so plugin reloads pick up fresh bundles.
  // V8 code cache persistence requires a validator header (Last-Modified or
  // ETag) on top of Cache-Control, so `Last-Modified` is emitted whenever the
  // handler has stats — without it Chromium treats the response as
  // non-cacheable and recompiles plugin scripts on every load (#8652).
  const cacheControl = isImmutableAppAsset(filePath)
    ? PLUGIN_IMMUTABLE_DIRECTIVE
    : PLUGIN_REVALIDATE_DIRECTIVE;

  return {
    "Content-Type": mimeType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Permissions-Policy": DAINTREE_APP_PERMISSIONS_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": cacheControl,
    ...(stats ? { "Last-Modified": toHttpDate(stats.mtime) } : {}),
  };
}

function buildPluginErrorHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/plain",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

/**
 * Create the plugin:// protocol handler.
 *
 * URL shape: `plugin://{pluginId}/{relative/path}`. The host segment is the
 * plugin's manifest name; the pathname is resolved against the plugin's
 * installed-on-disk root via `getPluginDir`. Security mirrors `daintree-file://`:
 * segment-by-segment `..` rejection, `fs.realpath()` containment, and
 * `O_RDONLY | O_NOFOLLOW` on the final open to close the realpath/open TOCTOU.
 */
export function createPluginProtocolHandler(getPluginDir: GetPluginDir) {
  return async (request: GlobalRequest) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: buildPluginErrorHeaders(),
      });
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Bad Request", {
        status: 400,
        headers: buildPluginErrorHeaders(),
      });
    }

    const pluginId = url.hostname;
    if (!pluginId) {
      return new Response("Not Found", {
        status: 404,
        headers: buildPluginErrorHeaders(),
      });
    }

    const pluginRoot = getPluginDir(pluginId);
    if (!pluginRoot) {
      // Unknown plugin id, or the plugin is currently disabled. 404 — do not
      // leak the existence of the disk path via a different status code.
      return new Response("Not Found", {
        status: 404,
        headers: buildPluginErrorHeaders(),
      });
    }

    const pathname = url.pathname;
    if (pathname === "/" || pathname === "") {
      // No directory listings — a bare `plugin://id/` is not a valid asset URL.
      return new Response("Not Found", {
        status: 404,
        headers: buildPluginErrorHeaders(),
      });
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname.startsWith("/") ? pathname.slice(1) : pathname);
    } catch {
      return new Response("Bad Request", {
        status: 400,
        headers: buildPluginErrorHeaders(),
      });
    }

    if (decodedPath.includes("\0")) {
      return new Response("Bad Request", {
        status: 400,
        headers: buildPluginErrorHeaders(),
      });
    }

    if (decodedPath.includes("\\")) {
      return new Response("Not Found", {
        status: 404,
        headers: buildPluginErrorHeaders(),
      });
    }

    // Drop the virtual view-generation namespace (#11301) before anything is
    // resolved against disk. It exists only to vary the ESM specifier across
    // plugin upgrades, so `__dtv-7/dist/view.js` and `__dtv-8/dist/view.js`
    // serve the same file — while a malformed reserved segment 404s rather than
    // reaching a real `__dtv-…` directory.
    const stripped = stripPluginViewGeneration(decodedPath);
    if (!stripped) {
      return new Response("Not Found", {
        status: 404,
        headers: buildPluginErrorHeaders(),
      });
    }
    decodedPath = stripped.path;

    // Normalize and re-check for '..'. The leading-slash normalize collapses
    // every `..` against the root, so the segment scan is redundant for
    // standard inputs — but cheap defense-in-depth against future changes to
    // posix.normalize semantics or edge-case inputs that surface a `..` after
    // decode. #4702: segment match, never substring `includes('..')`, which
    // would also reject legitimate paths like `..hidden/file.txt`. The actual
    // traversal defense is the realpath/path.relative containment below.
    const normalizedPosix = path.posix.normalize("/" + decodedPath).slice(1);
    if (normalizedPosix.split("/").some((seg) => seg === "..")) {
      return new Response("Not Found", {
        status: 404,
        headers: buildPluginErrorHeaders(),
      });
    }

    const candidatePath = path.resolve(pluginRoot, normalizedPosix);

    // Resolve symlinks before containment so an in-root symlink pointing
    // outside the plugin root is rejected (CVE-2025-53109 / -54794 class).
    let realRoot: string;
    let realFile: string;
    try {
      realRoot = await fs.realpath(pluginRoot);
      realFile = await fs.realpath(candidatePath);
    } catch {
      return new Response("Not Found", {
        status: 404,
        headers: buildPluginErrorHeaders(),
      });
    }

    const rel = path.relative(realRoot, realFile);
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
      return new Response("Not Found", {
        status: 404,
        headers: buildPluginErrorHeaders(),
      });
    }

    // Open the user-derived candidate path (not the realpath-resolved one)
    // with O_NOFOLLOW so a final-component symlink swap injected between
    // realpath and open is rejected with ELOOP. On Windows O_NOFOLLOW is 0
    // (no-op); realpath containment still applies. Mirrors daintree-file://.
    let fileHandle: Awaited<ReturnType<typeof fs.open>>;
    try {
      fileHandle = await fs.open(candidatePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (err) {
      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode === "ELOOP" || errCode === "ENOENT" || errCode === "EISDIR") {
        return new Response("Not Found", {
          status: 404,
          headers: buildPluginErrorHeaders(),
        });
      }
      console.error("[MAIN] plugin protocol open failed:", candidatePath, err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: buildPluginErrorHeaders(),
      });
    }

    try {
      // Stat via the open handle (no realpath/stat TOCTOU window) so the 304
      // shortcut and the Last-Modified validator share one source of truth.
      const fileStats = await fileHandle.stat();
      // fs.open succeeds on directories on POSIX; guard before the 304
      // short-circuit so a directory URL carrying If-Modified-Since falls
      // through to 404 instead of returning 304. Mirrors app://.
      if (!fileStats.isFile()) {
        return new Response("Not Found", {
          status: 404,
          headers: buildPluginErrorHeaders(),
        });
      }

      const mimeType = getMimeType(realFile);
      const ifModifiedSince = request.headers.get("If-Modified-Since");
      if (isNotModified(ifModifiedSince, fileStats.mtime)) {
        return new Response(null, {
          status: 304,
          headers: buildPluginHeaders(mimeType, realFile, fileStats),
        });
      }

      const buffer = await fileHandle.readFile();
      return new Response(buffer, {
        status: 200,
        headers: buildPluginHeaders(mimeType, realFile, fileStats),
      });
    } catch (err) {
      console.error("[MAIN] plugin protocol read failed:", candidatePath, err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: buildPluginErrorHeaders(),
      });
    } finally {
      // Swallow close errors so they don't mask a preceding readFile failure.
      await fileHandle.close().catch(() => {});
    }
  };
}

/**
 * Register app://, daintree-file://, daintree-html://, daintree-pdf:// and
 * plugin:// protocol handlers on a specific session.
 * Safe to call multiple times — skips sessions that are already configured.
 * Used for per-project session partitions that don't inherit the default session's handlers.
 *
 * `plugin://` is only registered when `registerPluginProtocol()` has already
 * cached a resolver — at runtime the default-session registration in
 * `app.whenReady()` always runs before any project view is created, so this is
 * effectively unconditional in production. Tests that don't exercise plugin://
 * skip this branch.
 */
export function registerProtocolsForSession(ses: Electron.Session, distPath: string): void {
  if (registeredSessions.has(ses)) return;
  registeredSessions.add(ses);

  ses.protocol.handle("app", createAppProtocolHandler(distPath));
  ses.protocol.handle("daintree-file", createDaintreeFileProtocolHandler());
  ses.protocol.handle("daintree-html", createDaintreeHtmlProtocolHandler());
  ses.protocol.handle("daintree-pdf", createDaintreePdfProtocolHandler());
  if (cachedGetPluginDir) {
    ses.protocol.handle("plugin", createPluginProtocolHandler(resolvePluginDir));
  }
}

export function registerAppProtocol(
  distPath: string,
  options: { allowDisplayCapture?: boolean } = {}
): void {
  cachedDistPath = distPath;
  // Demo mode records the renderer via getDisplayMedia(), which the default
  // `display-capture=()` Permissions-Policy blocks. Relax it to `(self)` only
  // when the caller opts in (demo mode, itself gated on `!app.isPackaged`), so
  // production keeps the deny-by-default posture. The flag is threaded from
  // main.ts rather than imported here to keep this module decoupled from the
  // heavyweight environment module (and its eager app.getPath side effects).
  if (options.allowDisplayCapture) {
    setAppPermissionsPolicy(buildAppPermissionsPolicy({ allowDisplayCapture: true }));
  }
  protocol.handle("app", createAppProtocolHandler(distPath));
}

/**
 * Claim the `daintree://` URI scheme as this build's OS-level default protocol
 * client (#9559) so deep links route to the running app. The durable OS
 * association is declared in `electron-builder.config.cjs` (`protocols`); this
 * runtime call ensures the launched build owns the scheme.
 *
 * Packaged-only: an unsigned dev/E2E build registering `daintree://` would
 * point the OS at the dev binary and pollute the user's Launch Services / XDG
 * handler database — the same reasoning that gates the macOS `.dntr`
 * `fileAssociations` on `CSC_LINK`.
 */
export function registerDeepLinkProtocolClient(): void {
  if (!app.isPackaged) return;
  app.setAsDefaultProtocolClient("daintree");
}

export function registerDaintreeFileProtocol(): void {
  protocol.handle("daintree-file", createDaintreeFileProtocolHandler());
}

export function registerDaintreeHtmlProtocol(): void {
  protocol.handle("daintree-html", createDaintreeHtmlProtocolHandler());
}

export function registerDaintreePdfProtocol(): void {
  protocol.handle("daintree-pdf", createDaintreePdfProtocolHandler());
}

// Stable indirection so the live `plugin://` resolver can be swapped after the
// deferred PluginService import settles (#10322) without re-registering the
// handler. Both the default-session handler and per-session handlers are wired
// to this function once; it reads `cachedGetPluginDir` at request time, so a
// later `setPluginDirResolver` is picked up live — no `protocol.unhandle`/
// re-`handle` (which would open a micro-tick `ERR_UNKNOWN_URL_SCHEME` gap).
function resolvePluginDir(pluginId: string): string | undefined {
  return cachedGetPluginDir ? cachedGetPluginDir(pluginId) : undefined;
}

export function registerPluginProtocol(getPluginDir: GetPluginDir): void {
  cachedGetPluginDir = getPluginDir;
  protocol.handle("plugin", createPluginProtocolHandler(resolvePluginDir));
}

/**
 * Swap the live `plugin://` directory resolver after the deferred PluginService
 * import settles (#10322). `registerPluginProtocol` runs before `createWindow`
 * with a placeholder resolver that returns `undefined` (every request 404s),
 * keeping the heavy ~2900-line PluginService module off the first-paint path.
 *
 * Ordering is load-bearing (#11728): the deferred `plugin-service` task must
 * call this immediately after importing the singleton and BEFORE `initialize()`
 * — not after it. `getPluginDir` is a plain map lookup, safe to install at any
 * time, whereas waiting for `initialize()` leaves the placeholder live across
 * the whole scan, during which the first plugin already publishes an addressable
 * `plugin://` componentPath. A 404 served in that window is permanent for that
 * specifier in the renderer's module map. The
 * handler delegates through `resolvePluginDir`, which reads `cachedGetPluginDir`
 * live, so the swap reaches every handler already registered (default session
 * plus any per-session handlers wired during `createWindow`).
 */
export function setPluginDirResolver(getPluginDir: GetPluginDir): void {
  cachedGetPluginDir = getPluginDir;
}

/**
 * Get the cached distPath for use when registering protocols on dynamic sessions.
 */
export function getDistPath(): string | null {
  return cachedDistPath;
}

// Read the production import-map hash sidecar emitted by the Vite build
// (`hostImportMapPlugin` in vite.config.ts). The hash must reach the
// `Content-Security-Policy` HTTP header layer so it stays aligned with the
// `<meta http-equiv>` value inside the document — the browser intersects the
// two policies, and a divergence silently drops the inline importmap. In dev,
// the sidecar doesn't exist (Vite serves React from the module graph and the
// dev CSP carries `'unsafe-inline'`), so this returns []. Failure to read or
// parse the sidecar in production logs a warning and returns []; without the
// hash the host page still loads, but plugins that externalize React will
// fail to resolve `react` at runtime — visible enough to debug, but not worth
// crashing app startup over a missing build artifact.
function loadHostImportMapHashes(distPath: string | null): string[] {
  if (process.env.NODE_ENV === "development") return [];
  if (!distPath) return [];

  try {
    const sidecarPath = path.join(distPath, "importmap-meta.json");
    const raw = readFileSync(sidecarPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "scriptSrcHashes" in parsed &&
      Array.isArray((parsed as { scriptSrcHashes: unknown }).scriptSrcHashes)
    ) {
      const hashes = (parsed as { scriptSrcHashes: unknown[] }).scriptSrcHashes.filter(
        (h): h is string => typeof h === "string"
      );
      return hashes;
    }
    console.warn("[MAIN] importmap-meta.json is malformed; missing scriptSrcHashes array.");
    return [];
  } catch (err) {
    console.warn("[MAIN] Failed to load importmap-meta.json sidecar:", err);
    return [];
  }
}

/**
 * Apply the strict Daintree app CSP to a dynamically-created trusted session
 * (paint-fabric surface views). Their `paint-surface:*` partitions are
 * deliberately NOT reclassified in classifyPartition: the "unknown" class is
 * what routes them through the session-created permission lockdown in
 * security.ts, and this helper restores the CSP half of the project-view
 * hardening that classification skips.
 */
export function applyDaintreeAppCspToSession(ses: Electron.Session): void {
  const scriptSrcHashes = loadHostImportMapHashes(cachedDistPath);
  const isDev = process.env.NODE_ENV === "development";
  const cspPolicy =
    scriptSrcHashes.length > 0
      ? getDaintreeAppCSP(isDev, { scriptSrcHashes })
      : getDaintreeAppCSP(isDev);
  ses.webRequest.onHeadersReceived(
    { urls: ["<all_urls>"], types: ["mainFrame", "subFrame", "script"] },
    (details, callback) => {
      if (shouldPreservePreviewResponseHeaders(details.url)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      callback({
        responseHeaders: mergeCspHeaders(details, cspPolicy),
      });
    }
  );
}

export function setupWebviewCSP(): void {
  const configuredPartitions = new Set<string>();
  const scriptSrcHashes = loadHostImportMapHashes(cachedDistPath);

  const applyCSP = (partition: string): void => {
    if (configuredPartitions.has(partition)) {
      return;
    }

    const partitionType = classifyPartition(partition);
    // Browser panels load arbitrary remote sites — overlaying our CSP would
    // intersect with theirs and break most of the web. Sandbox, deny-all
    // permissions, and navigation guards remain in place.
    if (partitionType === "unknown" || partitionType === "portal" || partitionType === "browser") {
      return;
    }

    const ses = session.fromPartition(partition);
    const isDev = process.env.NODE_ENV === "development";
    const cspPolicy =
      partitionType === "project"
        ? scriptSrcHashes.length > 0
          ? getDaintreeAppCSP(isDev, { scriptSrcHashes })
          : getDaintreeAppCSP(isDev)
        : getLocalhostDevCSP();

    // CSP response headers are only enforced on document and worker
    // main-script responses (workers map to "script" in the webRequest
    // resource-type model), so stylesheet/image/font/xhr/media/ping traffic
    // skips the network-service→main-process detour entirely. `urls` must be
    // explicit: since Electron 41 an empty array matches nothing, and
    // Electron 42 rejects "other" in `types` at registration.
    ses.webRequest.onHeadersReceived(
      { urls: ["<all_urls>"], types: ["mainFrame", "subFrame", "script"] },
      (details, callback) => {
        // Preview documents own their response headers. protocol.handle
        // responses DO flow through onHeadersReceived (Electron 42 /
        // Chromium 148), so without this bypass mergeCspHeaders would replace
        // a daintree-html:// page's token-scoped CSP with the trusted app CSP
        // — breaking its scripts AND re-exposing connect-src daintree-file: —
        // and would stamp that same policy onto a daintree-pdf:// document,
        // whose `frame-src` omits chrome-extension: and would therefore block
        // PDFium's internal viewer frame. Pass both through untouched.
        if (shouldPreservePreviewResponseHeaders(details.url)) {
          callback({ responseHeaders: details.responseHeaders });
          return;
        }
        callback({
          responseHeaders: mergeCspHeaders(details, cspPolicy),
        });
      }
    );

    configuredPartitions.add(partition);
  };

  // Configure static partitions:
  // - persist:daintree: trusted Daintree renderer shell (strict app CSP)
  // Browser hosts arbitrary remote sites (skipped by classifyPartition guard above
  // to avoid intersecting with site CSPs), portal/unknown are excluded, and
  // dev-preview partitions are wired dynamically via will-attach-webview below.
  applyCSP("persist:daintree");

  // Browser panel sessions are per-project (persist:browser-*) and created lazily,
  // so navigation handlers below discriminate by the webContents' partition string
  // rather than against a single cached session object.
  const isBrowserPanelContents = (contents: Electron.WebContents): boolean =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Electron typing gap: Session.partition is not exposed
    isBrowserPartition((contents.session as any)?.partition ?? "");

  // Monitor for dynamic dev-preview partitions
  app.on("web-contents-created", (_event, contents) => {
    const notifyBlockedNavigation = (url: string) => {
      const dialogService = getWebviewDialogService();
      const panelId = dialogService.getPanelId(contents.id);
      if (!panelId) return;

      const isDevPreview = !isBrowserPanelContents(contents);
      if (
        isDevPreview &&
        looksLikeOAuthUrl(url) &&
        "executeJavaScript" in contents &&
        typeof dialogService.storeOAuthSessionStorage === "function"
      ) {
        dialogService.storeOAuthSessionStorage(
          panelId,
          contents
            .executeJavaScript(
              `(() => {
                try {
                  return Object.entries(sessionStorage).filter(
                    (entry) =>
                      Array.isArray(entry) &&
                      entry.length === 2 &&
                      typeof entry[0] === "string" &&
                      typeof entry[1] === "string"
                  );
                } catch {
                  return [];
                }
              })()`
            )
            .catch((error: unknown) => {
              console.warn("[MAIN] Failed to capture OAuth sessionStorage snapshot:", error);
              return [];
            })
        );
      }

      const parentWindow = getWindowForWebContents(contents.hostWebContents ?? contents);
      if (parentWindow && !parentWindow.isDestroyed()) {
        getAppWebContents(parentWindow).send(CHANNELS.WEBVIEW_NAVIGATION_BLOCKED, {
          panelId,
          url,
          canOpenExternal: canOpenExternalUrl(url),
        });
      }
    };

    contents.on("will-attach-webview", (_event, _webPreferences, params) => {
      const partition = params.partition;
      if (partition && isDevPreviewPartition(partition)) {
        applyCSP(partition);
      }
    });

    // Route target="_blank" links and window.open() from webview guests to the system browser
    if (contents.getType() === "webview") {
      contents.setWindowOpenHandler(({ url }) => {
        // If this is an OAuth URL from a dev-preview webview, route it through
        // the blocked-nav banner so the user can use "Sign in via Browser" (loopback flow).
        // Without this, window.open() OAuth popups bypass the banner and go straight
        // to the system browser, losing the PKCE sessionStorage state.
        const isDevPreview = !isBrowserPanelContents(contents);
        if (url && isDevPreview && looksLikeOAuthUrl(url)) {
          notifyBlockedNavigation(url);
          return { action: "deny" };
        }

        if (url && canOpenExternalUrl(url)) {
          void openExternalUrl(url).catch((error) => {
            console.error("[MAIN] Failed to open webview external URL:", error);
          });
        } else {
          console.warn(`[MAIN] Blocked webview window.open for unsupported/empty URL: ${url}`);
        }
        return { action: "deny" };
      });

      // Block webview guest navigations to non-localhost URLs (closes TOCTOU gap
      // where will-attach-webview validates src at attachment but the guest can
      // navigate away afterwards).
      // Browser partition allows cross-origin http/https for OAuth/OIDC flows.
      // Dev-preview and other partitions remain restricted to localhost only.
      contents.on("will-navigate", (event, navigationUrl) => {
        const isBrowserPanel = isBrowserPanelContents(contents);

        const blocked = isBrowserPanel
          ? !isSafeNavigationUrl(navigationUrl)
          : !isLocalhostUrl(navigationUrl) && !isDevPreviewProxyUrl(navigationUrl);

        if (blocked) {
          const label = isBrowserPanel ? "unsafe" : "non-localhost";
          console.warn(`[MAIN] Blocked webview navigation to ${label} URL: ${navigationUrl}`);
          event.preventDefault();
          notifyBlockedNavigation(navigationUrl);
        }
      });

      contents.on("will-redirect", (event, redirectUrl) => {
        const isBrowserPanel = isBrowserPanelContents(contents);

        const blocked = isBrowserPanel
          ? !isSafeNavigationUrl(redirectUrl)
          : !isLocalhostUrl(redirectUrl) && !isDevPreviewProxyUrl(redirectUrl);

        if (blocked) {
          const label = isBrowserPanel ? "unsafe" : "non-localhost";
          console.warn(`[MAIN] Blocked webview redirect to ${label} URL: ${redirectUrl}`);
          event.preventDefault();
          notifyBlockedNavigation(redirectUrl);
        }
      });

      // Resolve and cache the guest's parent window. On the `destroyed` event the
      // guest's hostWebContents is no longer reachable, so dismiss-on-destroy falls
      // back to the reference captured while the guest was alive — populated when a
      // dialog is first intercepted below (a dialog can only be pending if this ran).
      let cachedParentWindow: Electron.BrowserWindow | null = null;
      const resolveParentWindow = (): Electron.BrowserWindow | null => {
        if (!contents.isDestroyed()) {
          const live = getWindowForWebContents(contents.hostWebContents ?? contents);
          if (live) cachedParentWindow = live;
        }
        return cachedParentWindow && !cachedParentWindow.isDestroyed() ? cachedParentWindow : null;
      };

      // Intercept JavaScript dialogs (alert/confirm/prompt) from webview guests.
      // Electron 40+ emits "js-dialog" but its TS types omit it from the overload union.
      (contents as { on: (event: string, listener: (...args: unknown[]) => void) => void }).on(
        "js-dialog",
        (
          event: unknown,
          _url: unknown,
          message: unknown,
          dialogType: unknown,
          defaultValue: unknown,
          callback: unknown
        ) => {
          (event as Electron.Event).preventDefault();
          const msg = message as string;
          const type = dialogType as string;
          const defVal = (defaultValue as string) ?? "";
          const cb = callback as (success: boolean, response?: string) => void;

          const dialogService = getWebviewDialogService();
          const dialogId = crypto.randomUUID();
          const panelId = dialogService.registerDialog(dialogId, contents.id, cb);

          if (!panelId) {
            cb(type === "alert");
            return;
          }

          const parentWindow = resolveParentWindow();
          if (parentWindow) {
            getAppWebContents(parentWindow).send("webview:dialog-request", {
              dialogId,
              panelId,
              type,
              message: msg,
              defaultValue: defVal,
            });
          } else {
            dialogService.resolveDialog(dialogId, type === "alert");
          }
        }
      );

      // Surface render-process hang to the renderer when the guest stops processing
      // input events for >30s. Auto-clears when `responsive` fires.
      const notifyUnresponsive = () => {
        if (contents.isDestroyed()) return;
        const panelId = getWebviewDialogService().getPanelId(contents.id);
        if (!panelId) return;
        const parentWindow = getWindowForWebContents(contents.hostWebContents ?? contents);
        if (parentWindow && !parentWindow.isDestroyed()) {
          getAppWebContents(parentWindow).send(CHANNELS.WEBVIEW_UNRESPONSIVE, { panelId });
        }
      };

      const notifyResponsive = () => {
        if (contents.isDestroyed()) return;
        const panelId = getWebviewDialogService().getPanelId(contents.id);
        if (!panelId) return;
        const parentWindow = getWindowForWebContents(contents.hostWebContents ?? contents);
        if (parentWindow && !parentWindow.isDestroyed()) {
          getAppWebContents(parentWindow).send(CHANNELS.WEBVIEW_RESPONSIVE, { panelId });
        }
      };

      contents.on("unresponsive", notifyUnresponsive);
      contents.on("responsive", notifyResponsive);

      // Dismiss any pending JS dialogs when the guest navigates to a new document,
      // its renderer crashes, or it is destroyed (e.g. the <webview> is remounted on
      // a partition change). Chromium discards the native dialog state in all three
      // cases, so the stored callback would otherwise leak and the renderer overlay
      // would survive a page that no longer exists. did-navigate fires only for
      // cross-document main-frame navigations (same-document hash/pushState changes
      // emit did-navigate-in-page and are correctly ignored). The destroyed path
      // relies on the cached parent window since hostWebContents is gone by then.
      const dismissPendingDialogs = () => {
        const dialogService = getWebviewDialogService();
        const panelId = dialogService.getPanelId(contents.id);
        dialogService.cancelPendingForGuest(contents.id);
        if (!panelId) return;
        const parentWindow = resolveParentWindow();
        if (parentWindow) {
          getAppWebContents(parentWindow).send(CHANNELS.WEBVIEW_DIALOG_DISMISS, { panelId });
        }
      };

      contents.on("did-navigate", dismissPendingDialogs);
      contents.on("render-process-gone", dismissPendingDialogs);
      contents.once("destroyed", dismissPendingDialogs);

      // Intercept find-in-page (Cmd/Ctrl+F, Cmd/Ctrl+G, Escape), reload
      // (Cmd/Ctrl+R), and close (Cmd/Ctrl+W) shortcuts from webview guests.
      // When the guest has focus Chromium routes keystrokes directly to it
      // — bypassing the host webContents' setIgnoreMenuShortcuts guards —
      // so they must be caught and forwarded here.
      contents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") return;
        const isMac = process.platform === "darwin";
        const mod = isMac ? input.meta : input.control;

        let shortcut: "find" | "next" | "prev" | "close" | null = null;
        if (input.key === "Escape") {
          shortcut = "close";
        } else if (mod && input.key.toLowerCase() === "f" && !input.alt && !input.shift) {
          shortcut = "find";
        } else if (mod && input.key.toLowerCase() === "g" && !input.alt) {
          shortcut = input.shift ? "prev" : "next";
        }

        const isReload = mod && input.key.toLowerCase() === "r" && !input.alt && !input.shift;
        // Match the host-level guard in createWindow.ts: require the
        // platform-correct close modifier and reject the opposite one, so
        // Ctrl+Cmd+W isn't treated as a plain close.
        const isCloseShortcut =
          input.key.toLowerCase() === "w" &&
          ((isMac && input.meta && !input.control) || (!isMac && input.control && !input.meta)) &&
          !input.alt &&
          !input.shift;

        if (!shortcut && !isReload && !isCloseShortcut) return;

        const dialogService = getWebviewDialogService();
        const panelId = dialogService.getPanelId(contents.id);
        if (!panelId) return;

        const findParentWindow = getWindowForWebContents(contents.hostWebContents ?? contents);

        if (isReload) {
          // Only dev-preview guests get Cmd/Ctrl+R reload — claiming the key for
          // other webview kinds (e.g. the browser panel) would swallow it from
          // the guest page, which has no reload handler of its own here.
          if (dialogService.getPanelKind(contents.id) !== "dev-preview") return;
          // preventDefault only when the signal can actually be delivered, so a
          // window teardown race doesn't eat the key with no reload to show for it.
          if (findParentWindow && !findParentWindow.isDestroyed()) {
            event.preventDefault();
            getAppWebContents(findParentWindow).send(CHANNELS.WEBVIEW_RELOAD_SHORTCUT, {
              panelId,
            });
          }
          return;
        }

        if (isCloseShortcut) {
          // Applies to every webview-hosting panel kind (dev-preview, browser)
          // — unlike reload, all of them need Cmd/Ctrl+W to close the panel
          // instead of falling through to the native role:"close" accelerator,
          // which would otherwise close the whole window (#10859).
          if (findParentWindow && !findParentWindow.isDestroyed()) {
            event.preventDefault();
            getAppWebContents(findParentWindow).send(CHANNELS.WEBVIEW_CLOSE_SHORTCUT, {
              panelId,
            });
          }
          return;
        }

        if (shortcut !== "close") {
          event.preventDefault();
        }
        if (findParentWindow && !findParentWindow.isDestroyed()) {
          getAppWebContents(findParentWindow).send(CHANNELS.WEBVIEW_FIND_SHORTCUT, {
            panelId,
            shortcut,
          });
        }
      });
    }
  });
}
