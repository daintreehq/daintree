import { CHANNELS } from "../ipc/channels.js";
import {
  SCOPED_PLUGIN_NAME_PATTERN,
  isCommunityPluginId,
  isRequestablePluginVersion,
} from "../schemas/pluginIdentifiers.js";
import { getAppWebContents } from "../window/webContentsRegistry.js";
import { watchMainFrameDocument } from "../utils/mainFrameNavigation.js";
import { onWebContentsDestroyed } from "../window/webContentsDestroyed.js";
import {
  clearPendingDaintreeUrls,
  getPendingDaintreeUrls,
  setDaintreeUrlConsumer,
} from "./deepLinkUrlQueue.js";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import type { PluginDeepLinkIntent, PluginDeepLinkRefusal } from "../../shared/types/plugin.js";

export const DAINTREE_DEEP_LINK_SCHEME = "daintree";
const SCHEME_PREFIX = `${DAINTREE_DEEP_LINK_SCHEME}://`;

// Cap the URL we echo into logs. A deep link is fully attacker-controlled (any
// web page can fire one), so a hostile actor could otherwise flood the log with
// a megabyte-long URI. Mirrors `UNTRUSTED_URL_MAX_CHARS` in plugin.ts.
const UNTRUSTED_URL_MAX_CHARS = 200;

function truncateForLog(raw: string): string {
  return raw.length > UNTRUSTED_URL_MAX_CHARS ? `${raw.slice(0, UNTRUSTED_URL_MAX_CHARS)}…` : raw;
}

const SHA256_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

/** The parameters that make an install link pinned or catalog-resolved. */
const BINDING_PARAMS = ["sha256", "id", "version"] as const;

function refuse(reason: PluginDeepLinkRefusal): PluginDeepLinkIntent {
  return { action: "install-refused", reason };
}

/** A web URL, or `null`; the scheme is the caller's to check. */
function parseWebUrl(value: string): URL | null {
  let nested: URL;
  try {
    nested = new URL(value);
  } catch {
    return null;
  }
  return nested.protocol === "https:" || nested.protocol === "http:" ? nested : null;
}

/**
 * The install link's intent. A link carrying `sha256`, `id` or `version` asks
 * for an install held to reviewed bytes, so a malformed one is refused with a
 * reason the user sees, never narrowed to an ordinary, unbound URL install.
 * Presence decides, not truthiness: an empty `sha256=` is still a pin.
 */
function parseInstallLink(params: URLSearchParams): PluginDeepLinkIntent | null {
  const bound = BINDING_PARAMS.some((name) => params.has(name));
  if (!bound) {
    const target = params.get("url");
    if (!target || !parseWebUrl(target)) return null;
    return { action: "install", url: target };
  }

  if ([...BINDING_PARAMS, "url"].some((name) => params.getAll(name).length > 1)) {
    return refuse("conflicting-params");
  }

  if (params.has("id")) {
    if (params.has("url") || params.has("sha256")) return refuse("conflicting-params");
    const pluginId = params.get("id") ?? "";
    if (!isCommunityPluginId(pluginId)) return refuse("malformed-id");
    if (!params.has("version")) return { action: "install-catalog", pluginId };
    const version = params.get("version") ?? "";
    if (!isRequestablePluginVersion(version)) return refuse("malformed-version");
    return { action: "install-catalog", pluginId, version };
  }

  // A version names a catalog release, so without an id it means nothing.
  if (params.has("version")) return refuse("conflicting-params");

  const sha256 = params.get("sha256") ?? "";
  if (!SHA256_HEX_PATTERN.test(sha256)) return refuse("malformed-sha256");
  const target = params.get("url");
  const nested = target ? parseWebUrl(target) : null;
  if (!target || !nested) return refuse("malformed-url");
  // The digest pins the bytes but says nothing about who sent them, and a
  // plaintext download shows everyone on the path what is being installed.
  if (nested.protocol !== "https:") return refuse("insecure-url");
  return { action: "install", url: target, sha256: sha256.toLowerCase() };
}

/**
 * Validate and narrow a raw `daintree://` URI to a {@link PluginDeepLinkIntent},
 * or `null` if it isn't a deep link we recognise. The URL is untrusted; every
 * branch fails closed.
 *
 * Accepted shapes:
 * - `daintree://plugin/install?url=<http(s) archive url>`
 * - `daintree://plugin/install?url=<https archive url>&sha256=<64 hex>`
 * - `daintree://plugin/install?id=<publisher.name>[&version=<semver>]`
 * - `daintree://plugin/open?id=<publisher.name>`
 *
 * The nested install `url` is only required to be `http:`/`https:` here — the
 * full SSRF / private-host / size gates live in the main-process download,
 * which every preview and install goes through. This parser's job is to reject
 * non-web schemes (`javascript:`, `file:`, `daintree:`) so a hostile deep link
 * can't pre-fill the dialog with something dangerous, and to refuse, visibly,
 * a pinned or catalog link it can't hold to what it names.
 */
export function parseDaintreeUrl(raw: string): PluginDeepLinkIntent | null {
  if (typeof raw !== "string" || !raw.startsWith(SCHEME_PREFIX)) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== `${DAINTREE_DEEP_LINK_SCHEME}:`) return null;
  // Only the `plugin` host is defined today; reject everything else so future
  // hosts must opt in explicitly rather than fall through to a plugin action.
  if (url.hostname !== "plugin") return null;

  if (url.pathname === "/install") return parseInstallLink(url.searchParams);

  if (url.pathname === "/open") {
    const pluginId = url.searchParams.get("id");
    if (!pluginId || !SCOPED_PLUGIN_NAME_PATTERN.test(pluginId)) return null;
    return { action: "open", pluginId };
  }

  return null;
}

/**
 * Extract the first `daintree://` URL from an argv array. On Windows/Linux a
 * deep link arrives as a bare argv entry — in `process.argv` for a cold launch,
 * or in the `second-instance` `commandLine` for a warm one. Unlike `.dntr`
 * paths, the OS delivers a single deep link per launch, so the first match
 * wins.
 */
export function extractDaintreeUrl(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith(SCHEME_PREFIX)) return arg;
  }
  return null;
}

let windowRegistry: WindowRegistry | null = null;
// Latest deep-link intent awaiting a painted renderer. Latest-wins: a deep link
// is a discrete user action, so a newer one supersedes an unconsumed older one
// rather than queuing.
let pendingIntent: PluginDeepLinkIntent | null = null;
// App-view webContents ids that have reported first paint. The deep-link
// renderer listener attaches during React mount (before paint), so a paint
// signal guarantees the listener is live — delivering earlier would race it
// onto the floor (#8465).
const paintedWebContentsIds = new Set<number>();
// Painted ids whose main frame has a navigation in flight. Held back from
// delivery until it either commits (a fresh paint is then required) or loading
// stops without a commit (the page is still there, painted as-is).
const leavingWebContentsIds = new Set<number>();
// Ids whose lifecycle listeners are already attached, so re-paints don't stack
// duplicate navigation / `destroyed` handlers.
const wiredWebContentsIds = new Set<number>();

// Flush callbacks run after every paint signal. Lets sibling OS-ingress queues
// (the `.dntr` archive queue, #11280) share this module's painted/primary
// bookkeeping without importing each other — registration points one way, so
// there is no import cycle.
const paintedFlushListeners = new Set<() => void>();

/** Register a callback invoked whenever an app view reports first paint. */
export function registerPaintedFlushListener(listener: () => void): void {
  paintedFlushListeners.add(listener);
}

function primaryAppWebContents(): Electron.WebContents | null {
  const win = windowRegistry?.getPrimary()?.browserWindow;
  if (!win || win.isDestroyed()) return null;
  const wc = getAppWebContents(win);
  return wc && !wc.isDestroyed() ? wc : null;
}

/**
 * The primary app view's webContents, but only once it has reported first
 * paint — i.e. the one target that is safe to push a main-originated intent to.
 * `null` while no primary exists or it hasn't painted, so callers hold their
 * intent rather than dropping it.
 */
export function getPaintedPrimaryWebContents(): Electron.WebContents | null {
  const wc = primaryAppWebContents();
  return wc && paintedWebContentsIds.has(wc.id) ? wc : null;
}

/**
 * Send the intent to a renderer. Returns whether the send succeeded so the
 * caller only clears `pendingIntent` on success — a teardown-race failure keeps
 * the intent queued for the next paint rather than silently dropping it.
 */
function deliver(webContents: Electron.WebContents, intent: PluginDeepLinkIntent): boolean {
  try {
    webContents.send(CHANNELS.EVENTS_PUSH, { name: "plugin:deep-link", payload: intent });
    return true;
  } catch {
    return false;
  }
}

/**
 * Attach lifecycle listeners (once per id) that keep the painted set honest: a
 * reload or a dead renderer takes the page's listener with it, so the id waits
 * for a fresh paint, and destroy removes the view entirely. Without this a deep
 * link after a reload would deliver to a not-yet-mounted renderer. Only the
 * main frame counts — a browser panel's `<webview>` attaching starts loading in
 * the same page, and treating that as a reload held every deep link forever —
 * and a navigation that never commits (cancelled by the navigation guard, as a
 * file dropped on the window is) leaves the painted page in place.
 */
function wireWebContentsLifecycle(webContents: Electron.WebContents): void {
  const id = webContents.id;
  if (wiredWebContentsIds.has(id)) return;
  wiredWebContentsIds.add(id);
  watchMainFrameDocument(webContents, {
    onLeaving: () => {
      if (paintedWebContentsIds.delete(id)) leavingWebContentsIds.add(id);
    },
    onReplaced: () => {
      paintedWebContentsIds.delete(id);
      leavingWebContentsIds.delete(id);
    },
    onSettled: () => {
      if (!leavingWebContentsIds.has(id)) return;
      // A renderer dying mid-navigation also stops loading, in its teardown,
      // before Electron reports it gone — and a send into it can still return
      // true. Decide a turn later, once a crash or a newer load is visible.
      setImmediate(() => {
        if (!leavingWebContentsIds.has(id)) return;
        if (webContents.isDestroyed() || webContents.isCrashed() || webContents.isLoading()) return;
        leavingWebContentsIds.delete(id);
        paintedWebContentsIds.add(id);
        flushToPaintedViews();
      });
    },
  });
  onWebContentsDestroyed(webContents, () => {
    paintedWebContentsIds.delete(id);
    leavingWebContentsIds.delete(id);
    wiredWebContentsIds.delete(id);
  });
}

/**
 * Route one raw deep-link URI to the renderer. If the primary view has already
 * painted (warm launch), deliver immediately; otherwise hold the intent until a
 * paint signal arrives (cold launch). Invalid URIs are logged and ignored — a
 * deep link must never crash the app.
 */
export function handleDaintreeUrl(raw: string): void {
  const intent = parseDaintreeUrl(raw);
  if (!intent) {
    console.warn(`[MAIN] Ignoring unrecognised daintree:// deep link: ${truncateForLog(raw)}`);
    return;
  }

  const wc = primaryAppWebContents();
  if (wc && paintedWebContentsIds.has(wc.id) && deliver(wc, intent)) {
    pendingIntent = null;
  } else {
    pendingIntent = intent;
  }
}

/**
 * Record that an app view has painted and flush any pending deep-link intent.
 * Called from the `app:view-painted` IPC handler. Delivering on paint (not on
 * window creation) ensures the renderer's deep-link listener is mounted.
 *
 * Delivery always targets the primary window (lesson #9533): if a non-primary
 * view paints first while the primary hasn't, the intent stays queued for the
 * primary rather than opening the Plugin Manager in the wrong window.
 */
export function notifyAppViewPainted(webContents: Electron.WebContents): void {
  wireWebContentsLifecycle(webContents);
  leavingWebContentsIds.delete(webContents.id);
  paintedWebContentsIds.add(webContents.id);
  flushToPaintedViews();
}

/** Hand everything held for a painted view to the views painted now. */
function flushToPaintedViews(): void {
  for (const listener of [...paintedFlushListeners]) {
    try {
      listener();
    } catch (err) {
      console.error("[MAIN] Painted-flush listener threw:", err);
    }
  }

  if (!pendingIntent) return;
  const primary = primaryAppWebContents();
  if (primary && paintedWebContentsIds.has(primary.id) && deliver(primary, pendingIntent)) {
    pendingIntent = null;
  }
}

/**
 * Wire the `daintree://` deep-link path once the window registry is available.
 * Takes over live macOS `open-url` events, then drains the cold-launch sources:
 * the macOS pre-ready `open-url` queue and the Windows/Linux `process.argv`
 * scan. Call once, after the primary window has been created.
 */
export function activateDeepLinkHandler(registry: WindowRegistry): void {
  windowRegistry = registry;

  // Take over live macOS `open-url` events first, so an event arriving mid-drain
  // routes through the consumer instead of landing in a queue we've snapshotted.
  setDaintreeUrlConsumer((url) => handleDaintreeUrl(url));

  // Windows/Linux cold launch: the deep link is an argv entry of this instance.
  const argvUrl = extractDaintreeUrl(process.argv);
  if (argvUrl) handleDaintreeUrl(argvUrl);

  // macOS cold launch: drain any `open-url` events queued before activation.
  const pending = getPendingDaintreeUrls();
  clearPendingDaintreeUrls();
  for (const url of pending) handleDaintreeUrl(url);
}

/** Test-only: reset module state between cases. */
export function _resetDeepLinkStateForTest(): void {
  windowRegistry = null;
  pendingIntent = null;
  paintedWebContentsIds.clear();
  leavingWebContentsIds.clear();
  wiredWebContentsIds.clear();
}
