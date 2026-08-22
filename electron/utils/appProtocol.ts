import path from "node:path";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { DAINTREE_APP_PERMISSIONS_POLICY } from "../../shared/config/permissionsPolicy.js";

// Permissions-Policy served on app:// responses. Deny-by-default with no
// runtime relaxation: the only caller that ever swapped this at runtime was
// demo mode, relaxing display-capture for the in-app recorder that no longer
// exists.
const appPermissionsPolicy = DAINTREE_APP_PERMISSIONS_POLICY;

export interface AppProtocolHeaders extends Record<string, string> {
  "Content-Type": string;
  "Cross-Origin-Opener-Policy": string;
  "Cross-Origin-Embedder-Policy": string;
  "Permissions-Policy": string;
  "X-Content-Type-Options": string;
  "Cross-Origin-Resource-Policy": string;
  "Cache-Control": string;
}

export interface BuildHeadersOptions {
  stats?: { mtime: Date };
  filePath?: string;
}

const ONE_YEAR_SECONDS = 31_536_000;
const IMMUTABLE_DIRECTIVE = `public, max-age=${ONE_YEAR_SECONDS}, immutable`;
const REVALIDATE_DIRECTIVE = "no-cache, must-revalidate";

// Vite content-hashed assets live under `assets/` as `<name>-<hash>.<ext>`. The
// hash is 8+ URL-safe characters — covers Vite's default 8-char hex and
// rolldown's 8-char xxHash base64url. Files outside `assets/` (e.g.
// `index.html`) are not fingerprinted and must revalidate.
const IMMUTABLE_ASSET_RE =
  /(?:^|[/\\])assets[/\\][^/\\]+-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|map|woff2?|ttf|otf|eot|png|svg|webp|gif|jpe?g|ico|bmp|wasm|avif)$/i;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  // Distinct from image/png so nosniff doesn't block the load: an unmapped
  // extension falls through to application/octet-stream below, which Chromium
  // refuses to decode as an image once nosniff is set.
  ".apng": "image/apng",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  // Spellings Chromium actually accepts: canPlayType("audio/flac") is
  // "probably" while "audio/x-flac" is "" — and daintree-file:// serves
  // nosniff, so a legacy alias here would leave the file unplayable. `.m4a`
  // and `.opus` stay bare (no codecs= parameter): the extension names the
  // container, not what's inside it, so promising a codec could be a lie.
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
};

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

export function isImmutableAppAsset(filePath: string): boolean {
  return IMMUTABLE_ASSET_RE.test(filePath);
}

export function toHttpDate(date: Date): string {
  return date.toUTCString();
}

// Returns true when the client's If-Modified-Since timestamp is at or after the
// file's mtime — the server should respond 304. HTTP dates have whole-second
// precision; we floor both sides to seconds to avoid false 200s from sub-second
// filesystem mtimes (e.g. 12:34:56.700 vs the 12:34:56 header).
export function isNotModified(headerValue: string | null, mtime: Date): boolean {
  if (!headerValue) return false;
  const parsedMs = Date.parse(headerValue);
  if (Number.isNaN(parsedMs)) return false;
  const mtimeSec = Math.floor(mtime.getTime() / 1000);
  const parsedSec = Math.floor(parsedMs / 1000);
  return mtimeSec <= parsedSec;
}

export function buildHeaders(
  mimeType: string,
  options: BuildHeadersOptions = {}
): AppProtocolHeaders {
  const { stats, filePath } = options;
  // V8 code cache persistence in Chromium requires both a non-`no-store`
  // Cache-Control AND a validator header (Last-Modified or ETag). Without
  // either, the renderer recompiles every cold launch. See issue #8624.
  const cacheControl =
    filePath && isImmutableAppAsset(filePath) ? IMMUTABLE_DIRECTIVE : REVALIDATE_DIRECTIVE;

  const headers: AppProtocolHeaders = {
    "Content-Type": mimeType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "credentialless",
    "Permissions-Policy": appPermissionsPolicy,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": cacheControl,
  };

  if (stats) {
    headers["Last-Modified"] = toHttpDate(stats.mtime);
  }

  return headers;
}

export function resolveAppUrlToDistPath(
  urlString: string,
  distRoot: string,
  options: { expectedHostname?: string } = {}
): { filePath: string; error?: string } {
  try {
    const url = new URL(urlString);

    if (url.protocol !== "app:") {
      return { filePath: "", error: "Invalid protocol" };
    }

    if (options.expectedHostname && url.hostname !== options.expectedHostname) {
      return { filePath: "", error: "Invalid host" };
    }

    let pathname = url.pathname;

    if (pathname === "/" || pathname === "") {
      pathname = "/index.html";
    }

    const relativePath = pathname.startsWith("/") ? pathname.slice(1) : pathname;

    const decodedPath = decodeURIComponent(relativePath);

    if (decodedPath.includes("\0")) {
      return { filePath: "", error: "Invalid path" };
    }
    if (decodedPath.includes("\\")) {
      return { filePath: "", error: "Invalid path separator" };
    }

    const normalizedPosix = path.posix.normalize("/" + decodedPath).slice(1);

    if (normalizedPosix.split("/").some((seg) => seg === "..")) {
      return { filePath: "", error: "Path traversal detected" };
    }

    const absoluteDistRoot = path.resolve(distRoot);
    const absoluteResolvedPath = path.resolve(absoluteDistRoot, normalizedPosix);

    if (
      !absoluteResolvedPath.startsWith(absoluteDistRoot + path.sep) &&
      absoluteResolvedPath !== absoluteDistRoot
    ) {
      return { filePath: "", error: "Path outside dist root" };
    }

    return { filePath: absoluteResolvedPath };
  } catch (error) {
    return {
      filePath: "",
      error: formatErrorMessage(error, "Failed to resolve app protocol path"),
    };
  }
}
