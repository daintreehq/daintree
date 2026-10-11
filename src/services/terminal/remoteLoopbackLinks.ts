import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { isLoopbackHostname, normalizeBrowserUrl } from "@shared/utils/urlUtils";

/**
 * Links a remote terminal prints that point at `localhost` mean the host's
 * localhost, not this machine's. Before such a link opens here, its port is
 * forwarded from the host (for the length of the flow: a sign-in callback
 * forward closes once idle) and the link is rewritten to the local end.
 *
 * A browser sign-in that names a loopback `redirect_uri` is the same problem
 * one hop later: the provider sends the browser back to the host's callback
 * port, so that port is forwarded before the provider page opens.
 */

const CALLBACK_PARAMS = ["redirect_uri", "redirect_url", "redirect", "callback", "callback_url"];

/** The remote host this view runs on, or null when it runs on this machine. */
export function remoteHostOfView(): string | null {
  if (typeof window === "undefined") return null;
  const id = window.__DAINTREE_HOST_ID__?.id;
  return typeof id === "string" && id !== LOCAL_HOST_ID ? id : null;
}

function portOf(url: URL): number | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** A loopback http(s) URL (bare `localhost:3000` included) and the port it names. */
export function parseLoopbackLink(text: string): { url: URL; port: number } | null {
  const normalized = normalizeBrowserUrl(text);
  if (!normalized.url) return null;
  let url: URL;
  try {
    url = new URL(normalized.url);
  } catch {
    return null;
  }
  if (!isLoopbackHostname(url.hostname)) return null;
  const port = portOf(url);
  return port === null ? null : { url, port };
}

/** The loopback port a non-loopback URL's query names as its redirect target, if any. */
export function callbackPortOf(text: string): number | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  for (const [key, value] of url.searchParams) {
    if (!CALLBACK_PARAMS.includes(key.toLowerCase())) continue;
    let target: URL;
    try {
      target = new URL(value);
    } catch {
      continue;
    }
    if (!isLoopbackHostname(target.hostname)) continue;
    const port = portOf(target);
    if (port !== null) return port;
  }
  return null;
}

async function forwardForFlow(hostId: string, remotePort: number, label: string) {
  return window.electron.portForwards.forward({
    hostId,
    remotePort,
    origin: "oauth-callback",
    label,
  });
}

/**
 * The URL a browser panel in this view loads for `text`: a `localhost` URL in
 * a view on a host means the host's localhost, so its port is forwarded here
 * (kept until stopped, like one forwarded by hand, since the page keeps using
 * it) to the same port, and the URL is unchanged. Anything else, and every URL
 * in a view on this machine, comes back untouched. Rejects when the forward
 * can't be made at that port: loading the URL anyway would reach this
 * machine's own server.
 */
export async function resolveBrowserUrlForView(text: string): Promise<string> {
  const hostId = remoteHostOfView();
  if (!hostId) return text;
  const loopback = parseLoopbackLink(text);
  if (!loopback) return text;
  const forward = await window.electron.portForwards.forward({
    hostId,
    remotePort: loopback.port,
    origin: "manual",
    label: "Browser panel",
  });
  // The page keeps the host's address: it is what the panel shows, saves and
  // forwards again after a reload, and a dev server's absolute URLs and
  // sockets name it too. A port taken here can't stand in for it.
  if (forward.localPort !== loopback.port) throw new HostPortInUseError(loopback.port);
  return loopback.url.toString();
}

/** The host's port is taken on this machine, so its page can't open here at the same address. */
export class HostPortInUseError extends Error {
  constructor(readonly port: number) {
    super(
      `Port ${port} is in use on this machine, so the host's page can't open here at the same address. Stop what's using it here, then try again.`
    );
    this.name = "HostPortInUseError";
  }
}

/** Whether a browser panel in this view has to forward `text`'s port before loading it. */
export function needsHostForward(text: string): boolean {
  return remoteHostOfView() !== null && parseLoopbackLink(text) !== null;
}

/**
 * The URL to open on this machine for a link printed by a terminal in this
 * view. Local views get the link back untouched. Rejects when a needed
 * forward can't be made: opening the link anyway would reach this machine's
 * localhost instead of the host's.
 */
export async function resolveTerminalLinkForView(text: string): Promise<string> {
  const hostId = remoteHostOfView();
  if (!hostId) return text;
  const loopback = parseLoopbackLink(text);
  if (loopback) {
    const forward = await forwardForFlow(hostId, loopback.port, "Opened from terminal");
    const local = new URL(loopback.url.toString());
    local.port = String(forward.localPort);
    return local.toString();
  }
  const callbackPort = callbackPortOf(text);
  if (callbackPort !== null) {
    const forward = await forwardForFlow(hostId, callbackPort, "Sign-in callback");
    // The provider sends the browser to the callback's own port; on any other
    // port it would land on whatever this machine runs there.
    if (forward.localPort !== callbackPort) {
      throw new Error(
        `Port ${callbackPort} is in use on this machine, so the host's sign-in callback can't reach it`
      );
    }
  }
  return text;
}
