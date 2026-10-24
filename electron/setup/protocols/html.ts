import path from "path";
import fs from "fs/promises";
import { getMimeType } from "../../utils/appProtocol.js";
import { resolveHtmlPreviewRoot } from "../htmlPreviewTokens.js";
import {
  buildDaintreeFileErrorHeaders,
  buildDaintreeFileHeaders,
  readContainedDaintreeFile,
} from "./containedFile.js";

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
export function createDaintreeHtmlProtocolHandler() {
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
