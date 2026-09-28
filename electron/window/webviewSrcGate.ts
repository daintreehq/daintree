import type { OnBeforeRequestListenerDetails, Session, WebContents } from "electron";
import ipaddr from "ipaddr.js";
import {
  isDevPreviewProxyUrl,
  isLocalhostUrl,
  isLoopbackHostname,
  isSafeNavigationUrl,
} from "../../shared/utils/urlUtils.js";

/**
 * Decides which URLs a webview in a remote-bound view may load: that host's
 * forwarded ports instead of this machine's localhost. Returns null for a
 * view that runs locally, which keeps the local rule.
 */
export type RemoteWebviewSrcGate = (webContentsId: number, src: string) => boolean | null;

/** Whether a view is bound to a remote host, without asking about any URL. */
export type RemoteViewProbe = (webContentsId: number) => boolean;

let remoteWebviewSrcGate: RemoteWebviewSrcGate | null = null;
let remoteViewProbe: RemoteViewProbe | null = null;

export function setRemoteWebviewSrcGate(
  gate: RemoteWebviewSrcGate | null,
  isRemoteView: RemoteViewProbe | null = null
): () => void {
  remoteWebviewSrcGate = gate;
  remoteViewProbe = isRemoteView;
  return () => {
    if (remoteWebviewSrcGate !== gate) return;
    remoteWebviewSrcGate = null;
    remoteViewProbe = null;
  };
}

/** Whether a view may attach a webview loading `src`. */
export function isWebviewSrcAllowed(webContentsId: number, src: string): boolean {
  const remote = remoteWebviewSrcGate?.(webContentsId, src) ?? null;
  if (remote !== null) return remote;
  // Dev-preview webviews load the stable proxy origin (dp-*.localhost), which
  // isLocalhostUrl rejects — accept it explicitly (#9100).
  return isLocalhostUrl(src) || isDevPreviewProxyUrl(src);
}

/** 0.0.0.0, [::] and their mapped spellings, which connect to loopback. */
function isUnspecified(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (!ipaddr.isValid(host)) return false;
  try {
    return ipaddr.process(host).range() === "unspecified";
  } catch {
    return false;
  }
}

const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

/**
 * An http(s) or ws(s) URL Chromium resolves to this machine: loopback, any
 * `*.localhost` name, or an unspecified address (which connects to loopback).
 */
function targetsThisMachine(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    if (!NETWORK_PROTOCOLS.has(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return (
      isLoopbackHostname(hostname) || hostname.endsWith(".localhost") || isUnspecified(hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Whether a webview guest embedded in `embedderWebContentsId` may navigate or
 * redirect to `url` after it attached. A dev-preview guest keeps the attach
 * rule; a browser panel may go to any http(s) page, except that in a
 * remote-bound view this machine's own localhost is reachable only through
 * the host's forwarded ports.
 */
export function isGuestNavigationAllowed(
  embedderWebContentsId: number,
  url: string,
  isBrowserPanel: boolean
): boolean {
  if (!isBrowserPanel) return isWebviewSrcAllowed(embedderWebContentsId, url);
  if (!isSafeNavigationUrl(url)) return false;
  if (!targetsThisMachine(url)) return true;
  return remoteWebviewSrcGate?.(embedderWebContentsId, url) ?? true;
}

/**
 * Whether a guest in `embedderWebContentsId` may open `url` in the system
 * browser from a popup: in a remote-bound view, never this machine's own
 * localhost except through the host's forwards.
 */
export function isGuestPopupAllowed(embedderWebContentsId: number, url: string): boolean {
  if (!targetsThisMachine(url)) return true;
  return remoteWebviewSrcGate?.(embedderWebContentsId, url) ?? true;
}

type GuestRequest = Pick<OnBeforeRequestListenerDetails, "url"> & {
  webContents?: Pick<WebContents, "hostWebContents"> | null;
};

/**
 * Whether a request from a session a remote-bound view's guest uses may go
 * out. Only requests to this machine are checked: a guest's own request is
 * judged for its embedder; one no guest owns (a service worker, a view sharing
 * the partition) must be allowed for every remote view the session has
 * served, and is refused once none is left.
 */
export function isGuestRequestAllowed(
  embedderIds: ReadonlySet<number>,
  details: GuestRequest
): boolean {
  if (!targetsThisMachine(details.url)) return true;
  const gate = remoteWebviewSrcGate;
  if (!gate) return true;
  const embedder = details.webContents?.hostWebContents?.id;
  if (embedder !== undefined) return gate(embedder, details.url) ?? true;
  let allowed = false;
  for (const id of embedderIds) {
    const verdict = gate(id, details.url);
    if (verdict === null) continue;
    if (!verdict) return false;
    allowed = true;
  }
  return allowed;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "an invalid URL";
  }
}

type GuardableSession = Pick<Session, "webRequest">;

const guardedSessions = new WeakMap<GuardableSession, Set<number>>();

/**
 * Put every request of `guest`'s session through {@link isGuestRequestAllowed}
 * once a remote-bound view embeds it: navigation checks never see fetch, img,
 * frames or WebSockets. Sessions only local views use get no listener at all.
 */
export function guardRemoteGuestRequests(
  embedderWebContentsId: number,
  guest: { session?: GuardableSession | null }
): void {
  if (!remoteViewProbe?.(embedderWebContentsId)) return;
  const session = guest.session;
  if (!session?.webRequest) return;
  const existing = guardedSessions.get(session);
  if (existing) {
    existing.add(embedderWebContentsId);
    return;
  }
  const embedders = new Set([embedderWebContentsId]);
  guardedSessions.set(session, embedders);
  session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    let allowed: boolean;
    try {
      allowed = isGuestRequestAllowed(embedders, details);
    } catch {
      allowed = false;
    }
    if (!allowed)
      console.warn(`[MAIN] Blocked a remote view's guest request to ${originOf(details.url)}`);
    callback(allowed ? {} : { cancel: true });
  });
}
