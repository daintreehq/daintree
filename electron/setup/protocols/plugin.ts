import { net, protocol } from "electron";
import path from "path";
import fs from "fs/promises";
import {
  getMimeType,
  isImmutableAppAsset,
  isNotModified,
  toHttpDate,
} from "../../utils/appProtocol.js";
import { DAINTREE_APP_PERMISSIONS_POLICY } from "../../../shared/config/permissionsPolicy.js";
import {
  parsePluginTourAudioPath,
  stripPluginViewGeneration,
} from "../../../shared/utils/pluginViewUrl.js";
import { fetchWithPrivateHostGuard } from "../../utils/pluginDownloadPolicy.js";
import { logWarn } from "../../utils/logger.js";
import { isPluginDirResolverLive, markPluginDirResolverLive } from "../pluginProtocolReadiness.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { parseRemotePluginAssetPath } from "../../../shared/types/pluginRemoteView.js";
import { isMediaMimeType, streamOpenedMediaFile } from "./containedFile.js";
import { trustedAppCorsOrigin } from "./appCors.js";

/**
 * Resolve a `plugin://` authority to the plugin root that serves it.
 *
 * The authority is an opaque token minted per plugin load and never reissued,
 * so a host-minted URL captured before an unload resolves to nothing rather
 * than into whatever now occupies that plugin id. A plugin's manifest id is
 * seeded as an alias alongside it — plugin authors write `plugin://{pluginId}/…`
 * by hand (docs/plugins/contribution-points.md), and that form keeps plain id
 * semantics. Both keys live in the same map, so neither gets its own resolution
 * path here.
 *
 * `undefined` means unknown, invalidated, or disabled.
 */
export type GetPluginRootByAuthority = (authority: string) => string | undefined;

/**
 * Resolve a tour chapter's remote-audio route on `authority` to the narration
 * URL the plugin's manifest declared, with the hosts every fetch hop must stay
 * on. `undefined` when no loaded plugin behind that authority registered it.
 */
export type GetPluginTourAudio = (
  authority: string,
  tourId: string,
  chapterId: string
) => { url: string; hosts: ReadonlySet<string> } | undefined;

let cachedPluginRootResolver: GetPluginRootByAuthority | null = null;
let cachedPluginTourAudioResolver: GetPluginTourAudio | null = null;

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
  stats?: { mtime: Date },
  corsOrigin?: string | null
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
    // Unconditional, not paired with the header below: the RESPONSE varies by
    // request `Origin` whether or not this particular one carries the echo, and
    // content-hashed plugin assets are served `immutable`. Without it a cached
    // entry stored for a tag load (no Origin, no echo) can be replayed to the
    // renderer's fetch(), which then fails CORS for no visible reason.
    Vary: "Origin",
    ...(corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin } : {}),
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

/** How long a remote narration host has to answer before the chapter plays silent. */
const PLUGIN_TOUR_AUDIO_TIMEOUT_MS = 15_000;

/**
 * Stream a tour chapter's remote narration through `plugin://` (#12773). The
 * renderer's `media-src` can't name every host a plugin declares, so main
 * fetches from the URL its registry holds and passes the audio through. Every
 * hop must stay https, on a host the tour declared, and off private addresses;
 * anything else fails the request, and the player falls back to captions.
 */
async function proxyPluginTourAudio(
  source: { url: string; hosts: ReadonlySet<string> },
  request: GlobalRequest,
  netFetch: typeof net.fetch
): Promise<Response> {
  const headers: Record<string, string> = {};
  const range = request.headers.get("range");
  if (range) headers.Range = range;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLUGIN_TOUR_AUDIO_TIMEOUT_MS);
  let upstream: Response;
  try {
    const guarded = await fetchWithPrivateHostGuard(
      netFetch,
      source.url,
      // Anonymous: the manifest picks this endpoint, so it gets no session cookies.
      { method: request.method, headers, signal: controller.signal, credentials: "omit" },
      (hostname) => source.hosts.has(hostname.toLowerCase())
    );
    if (!guarded.ok) {
      return new Response("Forbidden", { status: 403, headers: buildPluginErrorHeaders() });
    }
    upstream = guarded.response;
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: buildPluginErrorHeaders() });
  } finally {
    // The deadline covers reaching the host, not the length of the narration.
    clearTimeout(timer);
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  if (
    !(upstream.ok || upstream.status === 206) ||
    !contentType.toLowerCase().startsWith("audio/")
  ) {
    await upstream.body?.cancel().catch(() => {});
    return new Response("Bad Gateway", { status: 502, headers: buildPluginErrorHeaders() });
  }
  const passed: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) passed[name] = value;
  }
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: passed,
  });
}

/**
 * Which check produced a `plugin://` 404. A module import that 404s is
 * permanent for that specifier in the renderer's module map, so the log line is
 * the only place the cause survives — and `resolverLive` tells a request that
 * raced the deferred resolver install (#12996) apart from a genuinely unknown
 * or unloaded authority.
 */
type PluginNotFoundStage =
  | "no-authority"
  | "unknown-authority"
  | "no-path"
  | "backslash"
  | "malformed-generation"
  | "tour-audio"
  | "traversal"
  | "realpath"
  | "outside-root"
  | "open"
  | "not-a-file"
  | "media";

function logPluginNotFound(
  stage: PluginNotFoundStage,
  authority: string,
  pathname: string,
  cause?: unknown
): void {
  const errno = cause as NodeJS.ErrnoException | undefined;
  logWarn("plugin.protocol.not-found", {
    stage,
    authority,
    pathname,
    resolverLive: isPluginDirResolverLive(),
    ...(errno?.code ? { code: errno.code } : {}),
    ...(errno?.syscall !== undefined ? { syscall: errno.syscall } : {}),
  });
}

function pluginNotFound(
  stage: PluginNotFoundStage,
  authority: string,
  pathname: string,
  cause?: unknown
): Response {
  logPluginNotFound(stage, authority, pathname, cause);
  return new Response("Not Found", {
    status: 404,
    headers: buildPluginErrorHeaders(),
  });
}

/**
 * One `plugin://` asset a host served for a window attached to it. Only the
 * status and bytes cross from the host: every response header is decided
 * here, for this machine's requester, exactly as for a local asset.
 */
export interface RemotePluginAsset {
  status: number;
  body: Uint8Array | null;
  /** Epoch ms the file last changed on the host, for the V8 code cache validator. */
  lastModified?: number;
}

export type RemotePluginAssetProxy = (request: {
  hostId: string;
  authority: string;
  /** Path on the host, still URL-encoded, without a leading slash. */
  path: string;
  method: "GET" | "HEAD";
}) => Promise<RemotePluginAsset>;

let remotePluginAssetProxy: RemotePluginAssetProxy | null = null;

/** Installed by the remote-hosts client; the returned function removes it. */
export function setRemotePluginAssetProxy(proxy: RemotePluginAssetProxy | null): () => void {
  remotePluginAssetProxy = proxy;
  return () => {
    if (remotePluginAssetProxy === proxy) remotePluginAssetProxy = null;
  };
}

async function serveRemotePluginAsset(
  request: GlobalRequest,
  target: { hostId: string; authority: string; path: string }
): Promise<Response> {
  const proxy = remotePluginAssetProxy;
  if (!proxy) {
    return new Response("Not Found", { status: 404, headers: buildPluginErrorHeaders() });
  }
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  let asset: RemotePluginAsset;
  try {
    asset = await proxy({ ...target, method });
  } catch (err) {
    logWarn("plugin.protocol.remote-failed", {
      hostId: target.hostId,
      reason: formatErrorMessage(err, "remote plugin asset fetch failed"),
    });
    return new Response("Bad Gateway", { status: 502, headers: buildPluginErrorHeaders() });
  }
  if (asset.status !== 200) {
    const status = asset.status >= 400 && asset.status <= 599 ? asset.status : 502;
    return new Response(status === 404 ? "Not Found" : "Unavailable", {
      status,
      headers: buildPluginErrorHeaders(),
    });
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.path);
  } catch {
    decoded = target.path;
  }
  const assetPath = stripPluginViewGeneration(decoded)?.path ?? decoded;
  const stats =
    asset.lastModified !== undefined && Number.isFinite(asset.lastModified)
      ? { mtime: new Date(asset.lastModified) }
      : undefined;
  const body =
    method === "HEAD" || asset.body === null
      ? null
      : // A copy onto a plain ArrayBuffer: the link hands back views of a shared one.
        new Uint8Array(asset.body).buffer;
  return new Response(body, {
    status: 200,
    headers: buildPluginHeaders(
      getMimeType(assetPath),
      assetPath,
      stats,
      trustedAppCorsOrigin(request)
    ),
  });
}

/**
 * Create the plugin:// protocol handler.
 *
 * URL shape: `plugin://{authority}/{relative/path}`. The host segment is an
 * opaque per-load authority (or the plugin's manifest id, which PluginService
 * aliases to the same root); the pathname is resolved against the plugin's
 * installed-on-disk root via `getPluginRoot`. Security mirrors `daintree-file://`:
 * segment-by-segment `..` rejection, `fs.realpath()` containment, and
 * `O_RDONLY | O_NOFOLLOW` on the final open to close the realpath/open TOCTOU.
 */
export function createPluginProtocolHandler(
  getPluginRoot: GetPluginRootByAuthority,
  getTourAudio: GetPluginTourAudio = resolvePluginTourAudio,
  netFetch: typeof net.fetch = (input, init) => net.fetch(input, init)
) {
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

    const authority = url.hostname;
    if (!authority) {
      return pluginNotFound("no-authority", authority, url.pathname);
    }

    // A view of a window attached to another machine: its assets live on that
    // host and are fetched from it, never resolved against this machine's disk
    // (the authority was minted there, and an id alias could name a different
    // local copy of the plugin).
    const remote = parseRemotePluginAssetPath(url.pathname);
    if (remote === "malformed") {
      return new Response("Not Found", { status: 404, headers: buildPluginErrorHeaders() });
    }
    if (remote) {
      return serveRemotePluginAsset(request, { ...remote, authority });
    }

    const pluginRoot = getPluginRoot(authority);
    if (!pluginRoot) {
      // Unknown authority, an authority invalidated by an unload, or a plugin
      // that is currently disabled. 404 — do not leak the existence of the disk
      // path via a different status code.
      return pluginNotFound("unknown-authority", authority, url.pathname);
    }

    const pathname = url.pathname;
    if (pathname === "/" || pathname === "") {
      // No directory listings — a bare `plugin://id/` is not a valid asset URL.
      return pluginNotFound("no-path", authority, url.pathname);
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
      return pluginNotFound("backslash", authority, url.pathname);
    }

    // Drop the virtual view-generation namespace (#11301) before anything is
    // resolved against disk. It exists only to vary the ESM specifier across
    // plugin upgrades, so `__dtv-7/dist/view.js` and `__dtv-8/dist/view.js`
    // serve the same file — while a malformed reserved segment 404s rather than
    // reaching a real `__dtv-…` directory.
    const stripped = stripPluginViewGeneration(decodedPath);
    if (!stripped) {
      return pluginNotFound("malformed-generation", authority, url.pathname);
    }
    decodedPath = stripped.path;

    const tourAudio = parsePluginTourAudioPath(decodedPath);
    if (tourAudio !== null) {
      const source =
        tourAudio === "invalid"
          ? undefined
          : getTourAudio(authority, tourAudio.tourId, tourAudio.chapterId);
      if (!source) {
        return pluginNotFound("tour-audio", authority, url.pathname);
      }
      return proxyPluginTourAudio(source, request, netFetch);
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
      return pluginNotFound("traversal", authority, url.pathname);
    }

    const candidatePath = path.resolve(pluginRoot, normalizedPosix);

    // Resolve symlinks before containment so an in-root symlink pointing
    // outside the plugin root is rejected (CVE-2025-53109 / -54794 class).
    let realRoot: string;
    let realFile: string;
    try {
      realRoot = await fs.realpath(pluginRoot);
      realFile = await fs.realpath(candidatePath);
    } catch (err) {
      return pluginNotFound("realpath", authority, url.pathname, err);
    }

    const rel = path.relative(realRoot, realFile);
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
      return pluginNotFound("outside-root", authority, url.pathname);
    }

    // Open the user-derived candidate path (not the realpath-resolved one)
    // with O_NOFOLLOW so a final-component symlink swap injected between
    // realpath and open is rejected with ELOOP. On Windows O_NOFOLLOW is 0
    // (no-op); realpath containment still applies. Mirrors daintree-file://.
    let fileHandle: Awaited<ReturnType<typeof fs.open>>;
    try {
      fileHandle = await fs.open(
        candidatePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)
      );
    } catch (err) {
      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode === "ELOOP" || errCode === "ENOENT" || errCode === "EISDIR") {
        return pluginNotFound("open", authority, url.pathname, err);
      }
      console.error("[MAIN] plugin protocol open failed:", candidatePath, err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: buildPluginErrorHeaders(),
      });
    }

    let handedOff = false;
    try {
      // Stat via the open handle (no realpath/stat TOCTOU window) so the 304
      // shortcut and the Last-Modified validator share one source of truth.
      const fileStats = await fileHandle.stat();
      // fs.open succeeds on directories on POSIX; guard before the 304
      // short-circuit so a directory URL carrying If-Modified-Since falls
      // through to 404 instead of returning 304. Mirrors app://.
      if (!fileStats.isFile()) {
        return pluginNotFound("not-a-file", authority, url.pathname);
      }
      // The descriptor must be the file the contained real path names: an
      // ancestor swapped between the realpath and the open can't send it elsewhere.
      const realStats = await fs.stat(realFile).catch(() => null);
      if (!realStats || realStats.ino !== fileStats.ino || realStats.dev !== fileStats.dev) {
        return pluginNotFound("outside-root", authority, url.pathname);
      }

      const mimeType = getMimeType(realFile);
      // Tour narration (#12773) plays by `<audio>` tag, which seeks with byte
      // ranges; hand it to the range-aware streamer, on the descriptor just
      // checked, so what plays is the file that passed (the streamer owns and
      // closes it from here).
      if (isMediaMimeType(mimeType)) {
        handedOff = true;
        const streamed = await streamOpenedMediaFile(fileHandle, mimeType, request);
        if (streamed.status === 404) logPluginNotFound("media", authority, url.pathname);
        // Keep the trusted-document read a view's own fetch() of its bundled
        // media had before narration was streamed (WebAudio, blob playback).
        const mediaCorsOrigin = trustedAppCorsOrigin(request);
        streamed.headers.set("Vary", "Origin");
        if (mediaCorsOrigin) streamed.headers.set("Access-Control-Allow-Origin", mediaCorsOrigin);
        return streamed;
      }
      // The renderer reads a view module's own text over fetch() to compile its
      // Tailwind classes before the view mounts (#12220). Tag loads and ESM
      // imports never consult this; a cross-origin fetch() does, and the scheme
      // is corsEnabled, so without the echo the read fails. Scoped to the
      // trusted app document exactly as daintree-file:// is — that document
      // already imports these same bytes as a module, so this grants it nothing
      // it did not have, and grants a browser panel hosting a remote site
      // nothing at all.
      const corsOrigin = trustedAppCorsOrigin(request);
      const ifModifiedSince = request.headers.get("If-Modified-Since");
      if (isNotModified(ifModifiedSince, fileStats.mtime)) {
        return new Response(null, {
          status: 304,
          headers: buildPluginHeaders(mimeType, realFile, fileStats, corsOrigin),
        });
      }

      const buffer = await fileHandle.readFile();
      return new Response(buffer, {
        status: 200,
        headers: buildPluginHeaders(mimeType, realFile, fileStats, corsOrigin),
      });
    } catch (err) {
      console.error("[MAIN] plugin protocol read failed:", candidatePath, err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: buildPluginErrorHeaders(),
      });
    } finally {
      // Swallow close errors so they don't mask a preceding readFile failure.
      if (!handedOff) await fileHandle.close().catch(() => {});
    }
  };
}

// Stable indirection so the live `plugin://` resolver can be swapped after the
// deferred PluginService import settles (#10322) without re-registering the
// handler. Both the default-session handler and per-session handlers are wired
// to this function once; it reads `cachedPluginRootResolver` at request time,
// so a later `setPluginDirResolver` is picked up live — no `protocol.unhandle`/
// re-`handle` (which would open a micro-tick `ERR_UNKNOWN_URL_SCHEME` gap).
function resolvePluginRoot(authority: string): string | undefined {
  return cachedPluginRootResolver ? cachedPluginRootResolver(authority) : undefined;
}

function resolvePluginTourAudio(
  authority: string,
  tourId: string,
  chapterId: string
): ReturnType<GetPluginTourAudio> {
  return cachedPluginTourAudioResolver?.(authority, tourId, chapterId);
}

/** Point tour remote-audio routes at the live registry; installed beside the root resolver. */
export function setPluginTourAudioResolver(resolver: GetPluginTourAudio): void {
  cachedPluginTourAudioResolver = resolver;
}

/**
 * Serve one of this machine's `plugin://` assets to a window attached from
 * another machine, through the very handler local views use — same
 * containment, same symlink and traversal defences.
 */
export function fetchLocalPluginAsset(request: GlobalRequest): Promise<Response> {
  return createPluginProtocolHandler(resolvePluginRoot)(request);
}

export function registerPluginProtocol(getPluginRoot: GetPluginRootByAuthority): void {
  cachedPluginRootResolver = getPluginRoot;
  protocol.handle("plugin", createPluginProtocolHandler(resolvePluginRoot));
}

/**
 * Swap the live `plugin://` directory resolver after the deferred PluginService
 * import settles (#10322). `registerPluginProtocol` runs before `createWindow`
 * with a placeholder resolver that returns `undefined` (every request 404s),
 * keeping the heavy ~2900-line PluginService module off the first-paint path.
 *
 * Ordering is load-bearing (#11728): the deferred `plugin-service` task must
 * call this immediately after importing the singleton and BEFORE `initialize()`
 * — not after it. The resolver is a plain map lookup, safe to install at any
 * time, whereas waiting for `initialize()` leaves the placeholder live across
 * the whole scan, during which the first plugin already publishes an addressable
 * `plugin://` componentPath. A 404 served in that window is permanent for that
 * specifier in the renderer's module map. The
 * handler delegates through `resolvePluginRoot`, which reads
 * `cachedPluginRootResolver` live, so the swap reaches every handler already
 * registered (default session plus any per-session handlers wired during
 * `createWindow`).
 *
 * Also releases `whenPluginDirResolverLive()`, which every PluginService load
 * awaits — so the call is what lets any plugin publish a URL at all (#12996).
 */
export function setPluginDirResolver(getPluginRoot: GetPluginRootByAuthority): void {
  cachedPluginRootResolver = getPluginRoot;
  markPluginDirResolverLive();
}

/** The plugin:// half of registerProtocolsForSession: wired only once a resolver is cached. */
export function registerPluginProtocolForSession(ses: Electron.Session): void {
  if (cachedPluginRootResolver) {
    ses.protocol.handle("plugin", createPluginProtocolHandler(resolvePluginRoot));
  }
}
