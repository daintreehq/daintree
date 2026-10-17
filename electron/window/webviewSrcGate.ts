import type { OnBeforeRequestListenerDetails, Session, WebContents } from "electron";
import ipaddr from "ipaddr.js";
import { onWebContentsDestroyed, type DestroyableWebContents } from "./webContentsDestroyed.js";
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
let remoteHostOfView: ((webContentsId: number) => string | null) | null = null;

export function setRemoteWebviewSrcGate(
  gate: RemoteWebviewSrcGate | null,
  isRemoteView: RemoteViewProbe | null = null,
  hostOfView: ((webContentsId: number) => string | null) | null = null
): () => void {
  remoteWebviewSrcGate = gate;
  remoteViewProbe = isRemoteView;
  remoteHostOfView = hostOfView;
  return () => {
    if (remoteWebviewSrcGate !== gate) return;
    remoteWebviewSrcGate = null;
    remoteViewProbe = null;
    remoteHostOfView = null;
  };
}

/** Whether a view is bound to a remote host. */
export function isRemoteView(webContentsId: number): boolean {
  return remoteViewProbe?.(webContentsId) === true;
}

/** The host a view is bound to, or null for a view that runs here. */
export function remoteHostForView(webContentsId: number): string | null {
  return remoteHostOfView?.(webContentsId) ?? null;
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

/** Where an address is, as far as this machine is concerned. */
type Destination = "this-machine" | "local-network" | "elsewhere";

const THIS_MACHINE_RANGES = new Set(["loopback", "unspecified"]);
/** This computer's own network beyond itself: the LAN, link-local, and tailnets (CGNAT). */
const LOCAL_NETWORK_RANGES = new Set(["private", "linkLocal", "uniqueLocal", "carrierGradeNat"]);

/** The destination of a literal address, or null for anything that isn't one. */
function addressDestination(address: string): Destination | null {
  const host = address.replace(/^\[|\]$/g, "");
  if (!ipaddr.isValid(host)) return null;
  let range: string;
  try {
    range = ipaddr.process(host).range();
  } catch {
    return null;
  }
  if (THIS_MACHINE_RANGES.has(range)) return "this-machine";
  return LOCAL_NETWORK_RANGES.has(range) ? "local-network" : "elsewhere";
}

/** A network URL's hostname, lowercased and without a trailing dot; null for any other URL. */
function networkHostOf(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (!NETWORK_PROTOCOLS.has(parsed.protocol)) return null;
    return parsed.hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/** The destination a hostname names without asking DNS: an address, or a localhost name. */
function literalDestination(hostname: string): Destination | null {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return "this-machine";
  return addressDestination(hostname);
}

/** Resolves a hostname the way the session will when it connects. */
export type HostResolver = (hostname: string) => Promise<string[]>;

/** A lookup that takes longer than this can't vouch for a request, which is then refused. */
export const GUEST_RESOLVE_DEADLINE_MS = 5_000;

/**
 * Where a DNS name goes, by every address the resolver answers: this machine
 * if any is, this computer's network if any is, otherwise elsewhere. A
 * lookup that fails, answers nothing, answers something that isn't an
 * address, or outlasts the deadline is "unresolved", and never remembered.
 */
async function resolveDestination(
  resolve: HostResolver,
  hostname: string
): Promise<Destination | "unresolved"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), GUEST_RESOLVE_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    const addresses = await Promise.race([resolve(hostname).catch(() => null), deadline]);
    if (!addresses || addresses.length === 0) return "unresolved";
    const destinations = addresses.map(addressDestination);
    if (destinations.some((destination) => destination === null)) return "unresolved";
    if (destinations.includes("this-machine")) return "this-machine";
    return destinations.includes("local-network") ? "local-network" : "elsewhere";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One lookup per session and name at a time: requests that arrive while a
 * name is being resolved share the answer. Nothing outlives the lookup; the
 * session's own resolver keeps the cache its connections use.
 */
const pendingLookups = new WeakMap<object, Map<string, Promise<Destination | "unresolved">>>();

/** Distinct names one session may have in flight; more wait for one to finish. */
export const GUEST_MAX_PENDING_LOOKUPS = 64;
/** Names one session may have waiting for a slot; a request past them is refused. */
export const GUEST_MAX_QUEUED_LOOKUPS = 256;

/** Per session, the lookups waiting for a slot, each started when one frees. */
const queuedLookups = new WeakMap<object, Array<() => void>>();

function lookUp(
  session: object,
  resolve: HostResolver,
  hostname: string
): Promise<Destination | "unresolved"> {
  let pending = pendingLookups.get(session);
  if (!pending) {
    pending = new Map();
    pendingLookups.set(session, pending);
  }
  const inFlight = pending.get(hostname);
  if (inFlight) return inFlight;
  if (pending.size >= GUEST_MAX_PENDING_LOOKUPS) {
    // A page with many hosts waits its turn rather than losing resources at
    // random; each lookup has its deadline, so the queue drains.
    let queue = queuedLookups.get(session);
    if (!queue) {
      queue = [];
      queuedLookups.set(session, queue);
    }
    if (queue.length >= GUEST_MAX_QUEUED_LOOKUPS) return Promise.resolve("unresolved");
    const waiting = queue;
    return new Promise<void>((start) => waiting.push(start)).then(() =>
      lookUp(session, resolve, hostname)
    );
  }
  const slots = pending;
  const lookup = resolveDestination(resolve, hostname).finally(() => {
    slots.delete(hostname);
    queuedLookups.get(session)?.shift()?.();
  });
  slots.set(hostname, lookup);
  return lookup;
}

/**
 * What a remote-bound view's guest has shown, as its requests say: a
 * generation that moves with each top-level navigation, and whether anything
 * it has loaded since it was created came from this computer's own network.
 * That second one never clears: a navigation can fail or be cancelled and
 * leave such a page up, so a guest that has touched the network is never
 * captured for its host again.
 */
export interface GuestDocument {
  generation: number;
  localNetwork: boolean;
}

interface GuestRecord extends GuestDocument {
  /** Where each origin the guest loaded a document from was, when it loaded. */
  origins: Map<string, Destination>;
}

/** Origins remembered per guest; the oldest goes first. */
const MAX_GUEST_ORIGINS = 256;

const guestRecords = new Map<number, GuestRecord>();

/** The record of what a remote-bound view's guest has shown, or null when none was kept. */
export function guestDocument(webContentsId: number): GuestDocument | null {
  const record = guestRecords.get(webContentsId);
  return record ? { generation: record.generation, localNetwork: record.localNetwork } : null;
}

type DocumentRequest = Pick<OnBeforeRequestListenerDetails, "resourceType" | "url"> & {
  webContentsId?: number;
  webContents?: DestroyableWebContents | null;
};

function originOfUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

function noteLoaded(details: DocumentRequest, destination: Destination): void {
  const id = details.webContentsId;
  if (id === undefined) return;
  let record = guestRecords.get(id);
  if (!record) {
    record = { generation: 0, localNetwork: false, origins: new Map() };
    guestRecords.set(id, record);
    // The shared watcher: a guest already near its listener limit pays nothing more.
    try {
      if (details.webContents) {
        onWebContentsDestroyed(details.webContents, () => guestRecords.delete(id));
      }
    } catch {
      // Without a watcher the record stays until the id is reused: still never wrongly clean.
    }
  }
  if (details.resourceType === "mainFrame") record.generation++;
  if (destination === "local-network") record.localNetwork = true;
  if (details.resourceType === "mainFrame" || details.resourceType === "subFrame") {
    const origin = originOfUrl(details.url);
    if (origin !== null) {
      record.origins.delete(origin);
      record.origins.set(origin, destination);
      if (record.origins.size > MAX_GUEST_ORIGINS) {
        record.origins.delete(record.origins.keys().next().value!);
      }
    }
  }
}

/**
 * Whether a document of `origin` in guest `webContentsId` is on this
 * computer's network: by its address when the origin is one, otherwise by
 * where its name went when the document loaded. Never asked again: a name
 * that now answers with a LAN address doesn't make its page a LAN page.
 */
function originOnLocalNetwork(webContentsId: number | undefined, origin: string | null): boolean {
  const hostname = origin === null ? null : networkHostOf(origin);
  if (hostname === null) return false;
  const literal = literalDestination(hostname);
  if (literal !== null) return literal === "local-network";
  if (webContentsId === undefined) return false;
  return guestRecords.get(webContentsId)?.origins.get(origin!) === "local-network";
}

/**
 * Whether a page a remote-bound view's guest shows may be handed to its host
 * (a host-asked screenshot), judged by its URL: anything on the internet, or
 * this machine's localhost only through a port the host forwards. A page on
 * this computer's own network, by address or by a name that resolves there,
 * is not the host's to read. What the page loaded is judged separately, by
 * {@link guestDocument}.
 */
export async function isGuestPageReadableByHost(
  embedderWebContentsId: number,
  url: string,
  resolve: HostResolver
): Promise<boolean> {
  if (targetsThisMachine(url)) return remoteWebviewSrcGate?.(embedderWebContentsId, url) === true;
  const hostname = networkHostOf(url);
  if (hostname === null) return false;
  const literal = literalDestination(hostname);
  if (literal !== null) return literal === "elsewhere";
  return (await resolveDestination(resolve, hostname)) === "elsewhere";
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

type GuardableSession = Pick<Session, "webRequest"> & Partial<Pick<Session, "resolveHost">>;

const guardedSessions = new WeakMap<GuardableSession, Set<number>>();

/**
 * Put every request of `guest`'s session through {@link isGuestRequestAllowed}
 * and {@link judgeGuestRequest} once a remote-bound view embeds it:
 * navigation checks never see fetch, img, frames or WebSockets. Sessions only
 * local views use get no listener at all.
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
  const resolve: HostResolver | null =
    typeof session.resolveHost === "function"
      ? async (hostname) =>
          (await session.resolveHost!(hostname)).endpoints.map((endpoint) => endpoint.address)
      : null;
  session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    let answered = false;
    const answer = (allowed: boolean, destination: Destination | null = null) => {
      if (answered) return;
      answered = true;
      if (allowed && destination !== null) noteLoaded(details, destination);
      if (!allowed) {
        console.warn(`[MAIN] Blocked a remote view's guest request to ${originOf(details.url)}`);
      }
      callback(allowed ? {} : { cancel: true });
    };
    try {
      if (!isGuestRequestAllowed(embedders, details)) return answer(false);
      const hostname = networkHostOf(details.url);
      if (hostname === null) return answer(true);
      void judgeGuestRequest(session, resolve, details, hostname).then(
        (verdict) => answer(verdict.allowed, verdict.destination),
        () => answer(false)
      );
    } catch {
      answer(false);
    }
  });
}

/**
 * Where a remote-bound view's guest request goes, and whether it may. This
 * machine only through the host's forwards (already checked by
 * {@link isGuestRequestAllowed}; a name never is one), and this computer's
 * own network only for a top-level navigation or for a document that is
 * itself on that network: what the host serves, or the internet, can't
 * reach in. That is Chromium's Local Network Access rule, which Electron
 * leaves off, kept here for the guests a host's pages run in.
 */
async function judgeGuestRequest(
  session: object,
  resolve: HostResolver | null,
  details: Pick<OnBeforeRequestListenerDetails, "resourceType"> & {
    webContentsId?: number;
    frame?: {
      url?: string;
      origin?: string;
      parent?: { url?: string; origin?: string } | null;
    } | null;
  },
  hostname: string
): Promise<{ allowed: boolean; destination: Destination | null }> {
  // Read now, while the frame is live: the document asking, by its effective
  // origin (an about:blank or srcdoc frame has its creator's), and for an
  // iframe also its parent's, as the frame named may be the one being navigated.
  const askers: Array<string | null> = [];
  try {
    const frame = details.frame;
    if (frame) {
      askers.push(frame.origin ?? originOfUrl(frame.url));
      if (details.resourceType === "subFrame" && frame.parent) {
        askers.push(frame.parent.origin ?? originOfUrl(frame.parent.url));
      }
    }
  } catch {
    // A frame that went away vouches for nothing.
  }
  const destinationOf = async (name: string): Promise<Destination | "unresolved"> => {
    const literal = literalDestination(name);
    if (literal !== null) return literal;
    // No resolver to ask (a session that predates resolveHost): names go unchecked.
    return resolve ? lookUp(session, resolve, name) : "elsewhere";
  };
  const destination = await destinationOf(hostname);
  if (destination === "unresolved") return { allowed: false, destination: null };
  // A literal on this machine got here only as one of the host's forwards: the host's own content.
  if (destination === "this-machine") {
    return literalDestination(hostname) === "this-machine"
      ? { allowed: true, destination: "elsewhere" }
      : { allowed: false, destination: null };
  }
  if (destination === "elsewhere") return { allowed: true, destination };
  if (details.resourceType === "mainFrame") return { allowed: true, destination };
  if (askers.some((origin) => originOnLocalNetwork(details.webContentsId, origin))) {
    return { allowed: true, destination };
  }
  return { allowed: false, destination: null };
}
