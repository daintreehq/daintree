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

let remoteWebviewSrcGate: RemoteWebviewSrcGate | null = null;

export function setRemoteWebviewSrcGate(gate: RemoteWebviewSrcGate | null): () => void {
  remoteWebviewSrcGate = gate;
  return () => {
    if (remoteWebviewSrcGate === gate) remoteWebviewSrcGate = null;
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

/**
 * An http(s) URL Chromium resolves to this machine: loopback, any `*.localhost`
 * name, or an unspecified address (which connects to loopback).
 */
function targetsThisMachine(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
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
