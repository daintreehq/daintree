import { isValidRemoteHostId } from "../../../shared/types/remoteHosts.js";
import { buildDaintreeFileErrorHeaders } from "./containedFile.js";

/** The three query-string schemes that serve a file from inside a root. */
export type ContainedFileScheme = "daintree-file" | "daintree-media" | "daintree-pdf";

/**
 * Serves a host-scoped request for a window attached to a remote host: the
 * file lives on that host, so it has to be fetched from there rather than read
 * from this machine at the same path.
 */
export type HostFileRequestProxy = (
  scheme: ContainedFileScheme,
  target: HostScopedFileTarget,
  request: GlobalRequest
) => Promise<Response>;

/**
 * The host a preview URL names, and the capability of the view that built it.
 * A protocol request carries no sender, so the capability (minted by main for
 * one view) is the only thing that says whose authority the request runs
 * under; null when the URL has none, which the proxy refuses.
 */
export interface HostScopedFileTarget {
  hostId: string;
  viewCapability: string | null;
}

let hostFileRequestProxy: HostFileRequestProxy | null = null;

/** Installed by the remote-hosts client; the returned function removes it. */
export function setHostFileRequestProxy(proxy: HostFileRequestProxy | null): () => void {
  hostFileRequestProxy = proxy;
  return () => {
    if (hostFileRequestProxy === proxy) hostFileRequestProxy = null;
  };
}

/**
 * A remote view's preview URLs carry the host and the view's capability in
 * the authority and path —
 * `daintree-file://host/<hostId>/<capability>/load?path=…&root=…` (the media
 * scheme keeps its trailing `load/`). Local URLs use the `load` authority and
 * never match, so they keep their exact shape and handling. A URL with the
 * `host` authority is never served from this machine, even when malformed.
 */
export function parseHostScopedFileUrl(url: string): HostScopedFileTarget | "malformed" | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.host !== "host") return null;
  const match = /^\/([^/]+)(?:\/([0-9a-f]{32}))?\/load\/?$/.exec(parsed.pathname);
  if (!match) return "malformed";
  let hostId: string;
  try {
    hostId = decodeURIComponent(match[1]!);
  } catch {
    return "malformed";
  }
  return isValidRemoteHostId(hostId) ? { hostId, viewCapability: match[2] ?? null } : "malformed";
}

export async function answerHostScopedRequest(
  scheme: ContainedFileScheme,
  request: GlobalRequest
): Promise<Response | null> {
  const target = parseHostScopedFileUrl(request.url);
  if (target === null) return null;
  if (target === "malformed") {
    return new Response("Invalid host URL", {
      status: 400,
      headers: buildDaintreeFileErrorHeaders(),
    });
  }
  const proxy = hostFileRequestProxy;
  if (!proxy) {
    return new Response("Host not connected", {
      status: 503,
      headers: buildDaintreeFileErrorHeaders(),
    });
  }
  try {
    return await proxy(scheme, target, request);
  } catch (err) {
    console.error(`[MAIN] ${scheme} host proxy error:`, err);
    return new Response("Bad Gateway", {
      status: 502,
      headers: buildDaintreeFileErrorHeaders(),
    });
  }
}

/** The local-form URL of a contained-file request, as the renderer builds it. */
export function buildContainedFileUrl(
  scheme: ContainedFileScheme,
  filePath: string,
  rootPath: string
): string {
  const query = `?path=${encodeURIComponent(filePath)}&root=${encodeURIComponent(rootPath)}`;
  return scheme === "daintree-media" ? `${scheme}://load/${query}` : `${scheme}://load${query}`;
}
