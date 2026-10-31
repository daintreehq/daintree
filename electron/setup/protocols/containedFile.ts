import path from "path";
import fs from "fs/promises";
import { Readable } from "node:stream";
import { getMimeType } from "../../utils/appProtocol.js";
import { readBoundedFromHandle } from "../../utils/boundedRead.js";

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

export function isPdfPath(filePath: string): boolean {
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
export type DaintreeReadKind = "file" | "asset" | "pdf";

// The size ceiling for a resolved file, chosen from its canonical path.
export function maxBytesForFile(realFile: string, kind: DaintreeReadKind): number {
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
export function buildDaintreeFileHeaders(
  mimeType: string,
  contentLength: number
): Record<string, string> {
  return {
    "Content-Type": mimeType,
    "Content-Length": String(contentLength),
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

export function buildDaintreeFileErrorHeaders(): Record<string, string> {
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
export function isMediaMimeType(mimeType: string): boolean {
  return mimeType.startsWith("video/") || mimeType.startsWith("audio/");
}

/**
 * The most bytes a whole-response preview of `filePath` under `scheme` may
 * carry, as this machine's own handler holds it; null for audio and video,
 * which stream (a host-served preview is held to the same).
 */
export function previewByteCeiling(
  scheme: "daintree-file" | "daintree-media" | "daintree-pdf",
  filePath: string
): number | null {
  if (scheme === "daintree-pdf") return DAINTREE_PDF_MAX_BYTES;
  if (isMediaMimeType(getMimeType(filePath))) return null;
  return maxBytesForFile(filePath, "file");
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
export async function streamContainedMediaFile(
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

  return streamOpenedMediaFile(fileHandle, mimeType, request);
}

/**
 * The post-open half of {@link streamContainedMediaFile}: everything is
 * decided from the descriptor, which this takes ownership of.
 */
export async function streamOpenedMediaFile(
  fileHandle: Awaited<ReturnType<typeof fs.open>>,
  mimeType: string,
  request: GlobalRequest
): Promise<Response> {
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
export async function resolveContainedRealPath(
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
 * Shared open core for daintree-file://, daintree-html:// and daintree-pdf://:
 * realpath containment, a size cap (per maxBytesForFile, selected by `kind`),
 * and O_RDONLY|O_NOFOLLOW open. Returns the open handle plus the canonical path
 * (for MIME) and the cap it was admitted under, or an error Response. The
 * caller owns closing the handle. The flow (realpath → path.relative → stat →
 * O_NOFOLLOW open) and its TOCTOU defenses are unchanged.
 */
async function openContainedDaintreeFile(
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

  return { fileHandle, realFile, maxBytes, sizeHint: fileStat.size };
}

/**
 * The bytes of a contained file, or an error Response. Callers own the success
 * headers so each scheme sets its own CSP.
 */
// Return type is inferred, not annotated: annotating `buffer: Buffer` widens it
// to `Buffer<ArrayBufferLike>`, which `new Response(...)` rejects as a BodyInit.
// Inference preserves the exact `Buffer<ArrayBuffer>` the Response accepts.
export async function readContainedDaintreeFile(
  normalizedRoot: string,
  normalizedFile: string,
  kind: DaintreeReadKind
) {
  const opened = await openContainedDaintreeFile(normalizedRoot, normalizedFile, kind);
  if (opened instanceof Response) return opened;
  const { fileHandle, realFile, maxBytes, sizeHint } = opened;

  try {
    // The pre-read stat is advisory: a writer can grow or swap the file between
    // stat and read (O_NOFOLLOW blocks only a final-component symlink swap, not
    // a regular-file replacement or in-place growth). The read itself holds the
    // cap, so neither main nor the renderer ever buffers past it.
    const buffer = await readBoundedFromHandle(fileHandle, sizeHint, maxBytes);
    if (buffer === null) {
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
 * The size of a contained file, or an error Response — the HEAD half of
 * {@link readContainedDaintreeFile}. It passes the same containment, gate, cap
 * and O_NOFOLLOW open a GET would, so a probe refuses everything the read
 * refuses structurally, but it never reads the bytes it only has to measure.
 * A read can still fail where the stat passed — a rewrite in between, or an
 * I/O error only the read surfaces — so this is admission, not a guarantee.
 */
export async function statContainedDaintreeFile(
  normalizedRoot: string,
  normalizedFile: string,
  kind: DaintreeReadKind
) {
  const opened = await openContainedDaintreeFile(normalizedRoot, normalizedFile, kind);
  if (opened instanceof Response) return opened;
  const { fileHandle, realFile, maxBytes } = opened;

  try {
    // Measured on the descriptor, not the pre-open stat, for the same reason
    // the read re-checks its buffer: the file can grow in between. A directory
    // named `x.pdf` opens fine but can't be read, so it isn't admitted either.
    const stats = await fileHandle.stat();
    if (!stats.isFile()) {
      return new Response("Not Found", {
        status: 404,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
    const { size } = stats;
    if (size > maxBytes) {
      return new Response("Payload Too Large", {
        status: 413,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
    // The same rule as files:read's `pathIsCanonical`: a hard-linked file has
    // more than one real path, and a directory watch only reports the name it
    // was written through.
    const pathIsCanonical = realFile === normalizedFile && !(stats.nlink > 1);
    return { size, realFile, pathIsCanonical };
  } finally {
    await fileHandle.close().catch(() => {});
  }
}

/**
 * Method gate and `?path=&root=` validation shared by the three query-string
 * schemes (daintree-file://, daintree-pdf://, daintree-media://). Returns the
 * normalized pair, or the Response to relay.
 *
 * Validation order is load-bearing and identical for all three: a malformed
 * request must be refused on its shape before anything touches the filesystem.
 */
export function parseContainedFileRequest(
  request: GlobalRequest
): { normalizedRoot: string; normalizedFile: string } | Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: buildDaintreeFileErrorHeaders(),
    });
  }

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

  return { normalizedRoot: path.normalize(rootPath), normalizedFile: path.normalize(filePath) };
}
