import { protocol } from "electron";
import fs from "fs/promises";
import {
  resolveAppUrlToDistPath,
  getMimeType,
  buildHeaders,
  isNotModified,
  setAppPermissionsPolicy,
} from "../../utils/appProtocol.js";
import { buildAppPermissionsPolicy } from "../../../shared/config/permissionsPolicy.js";
import { logWarn } from "../../utils/logger.js";

let cachedDistPath: string | null = null;

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

export function createAppProtocolHandler(distPath: string) {
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
 * Get the cached distPath for use when registering protocols on dynamic sessions.
 */
export function getDistPath(): string | null {
  return cachedDistPath;
}
