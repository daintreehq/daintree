// eager-import-allow: sets up custom protocols (daintree, plugin) and security headers (CSP) eagerly on startup
import { app, protocol, session } from "electron";
import { getWindowForWebContents, getAppWebContents } from "../window/webContentsRegistry.js";
import path from "path";
import fs from "fs/promises";
import { readFileSync } from "node:fs";
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
import {
  classifyPartition,
  getDaintreeAppCSP,
  getLocalhostDevCSP,
  mergeCspHeaders,
  isDevPreviewPartition,
} from "../utils/webviewCsp.js";
import { canOpenExternalUrl, openExternalUrl } from "../utils/openExternal.js";
import {
  isLocalhostUrl,
  isDevPreviewProxyUrl,
  isSafeNavigationUrl,
} from "../../shared/utils/urlUtils.js";
import { isBrowserPartition } from "../../shared/utils/partitionUtils.js";
import { getWebviewDialogService } from "../services/WebviewDialogService.js";
import { looksLikeOAuthUrl } from "../services/OAuthLoopbackService.js";
import { CHANNELS } from "../ipc/channels.js";

export type GetPluginDir = (pluginId: string) => string | undefined;

// Track which sessions have had protocols registered to avoid double-registration
const registeredSessions = new WeakSet<Electron.Session>();
let cachedDistPath: string | null = null;
let cachedGetPluginDir: GetPluginDir | null = null;

/**
 * Create the app:// protocol handler function for a given distPath.
 */
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
      console.error("[MAIN] App protocol error:", error);
      return new Response("Not Found", {
        status: 404,
        headers: buildHeaders("text/plain"),
      });
    }

    // V8 code cache in Chromium 146 won't persist bytecode without both a
    // non-`no-store` Cache-Control AND a validator header. We stat the file
    // first so the validator and the 304 shortcut are both available — without
    // the 304 path every reload returns a fresh 200 that invalidates the
    // bytecode entry. See issue #8624.
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(filePath);
    } catch {
      return new Response("Not Found", {
        status: 404,
        headers: buildHeaders("text/plain"),
      });
    }

    // stat() succeeds on directories, so guard before the 304 short-circuit:
    // without this a directory URL carrying If-Modified-Since would return 304
    // instead of falling through to the open/read 404 path.
    if (!stats.isFile()) {
      return new Response("Not Found", {
        status: 404,
        headers: buildHeaders("text/plain"),
      });
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
    // in-memory copy on every asset load for no caching benefit. No O_NOFOLLOW:
    // unlike daintree-file:// / plugin://, resolveAppUrlToDistPath does lexical
    // (path.resolve + startsWith) containment with no realpath, so there is no
    // realpath/open TOCTOU window for the flag to close — adding it would imply
    // a defense that isn't set up here. dist assets are application-owned.
    let fileHandle: Awaited<ReturnType<typeof fs.open>>;
    try {
      fileHandle = await fs.open(filePath, fs.constants.O_RDONLY);
    } catch (err) {
      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT" || errCode === "EISDIR") {
        return new Response("Not Found", {
          status: 404,
          headers: buildHeaders("text/plain"),
        });
      }
      console.error("[MAIN] Error serving file:", filePath, err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: buildHeaders("text/plain"),
      });
    }

    try {
      const buffer = await fileHandle.readFile();
      return new Response(buffer, {
        status: 200,
        headers: buildHeaders(getMimeType(filePath), { stats, filePath }),
      });
    } catch (err) {
      // fs.open on a directory succeeds on macOS/Linux; the EISDIR only surfaces
      // here at readFile. Map it to 404 like the open path so a directory URL
      // never returns a 500.
      if ((err as NodeJS.ErrnoException).code === "EISDIR") {
        return new Response("Not Found", {
          status: 404,
          headers: buildHeaders("text/plain"),
        });
      }
      console.error("[MAIN] Error serving file:", filePath, err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: buildHeaders("text/plain"),
      });
    } finally {
      // Swallow close errors so they don't mask a preceding readFile failure.
      await fileHandle.close().catch(() => {});
    }
  };
}

// Parity with the files:read IPC handler (electron/ipc/handlers/files.ts).
// Files larger than this are rejected with 413 before any read, preventing
// renderer OOM via a malicious or accidental large-file URL.
const DAINTREE_FILE_MAX_BYTES = 512 * 1024;

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

/**
 * Create the daintree-file:// protocol handler function.
 */
function createDaintreeFileProtocolHandler() {
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

      const normalizedFile = path.normalize(filePath);
      const normalizedRoot = path.normalize(rootPath);

      // Resolve symlinks before containment to block in-root symlinks pointing outside root (CVE-2025-53109 / CVE-2025-54794 class).
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

      if (fileStat.size > DAINTREE_FILE_MAX_BYTES) {
        return new Response("Payload Too Large", {
          status: 413,
          headers: buildDaintreeFileErrorHeaders(),
        });
      }

      // Open the user-supplied normalized path (not realFile) with O_NOFOLLOW
      // so a final-component symlink injected after the realpath check is
      // rejected with ELOOP. Closes the TOCTOU gap between realpath and the
      // actual read. On Windows O_NOFOLLOW is 0 (no-op); realpath containment
      // still applies. Mirrors the files:read IPC handler.
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
        const mimeType = getMimeType(realFile);
        // Content-Length reflects the bytes actually returned. If the file
        // grew between stat() and readFile(), buffer.length is the truth;
        // fileStat.size would be stale.
        return new Response(buffer, {
          status: 200,
          headers: buildDaintreeFileHeaders(mimeType, buffer.length),
        });
      } finally {
        // Swallow close errors so they don't mask a preceding readFile failure.
        await fileHandle.close().catch(() => {});
      }
    } catch (err) {
      console.error("[MAIN] daintree-file protocol error:", err);
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
 * Register app://, daintree-file://, and plugin:// protocol handlers on a specific session.
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
 * Once the deferred `plugin-service` task initializes the singleton, it calls
 * this to point the already-registered handler at the real `getPluginDir`. The
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
