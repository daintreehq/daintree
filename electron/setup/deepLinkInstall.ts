import { CHANNELS } from "../ipc/channels.js";
import { SCOPED_PLUGIN_NAME_PATTERN } from "../schemas/plugin.js";
import { getAppWebContents } from "../window/webContentsRegistry.js";
import {
  clearPendingDaintreeUrls,
  getPendingDaintreeUrls,
  setDaintreeUrlConsumer,
} from "./deepLinkUrlQueue.js";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import type { PluginDeepLinkIntent } from "../../shared/types/plugin.js";

export const DAINTREE_DEEP_LINK_SCHEME = "daintree";
const SCHEME_PREFIX = `${DAINTREE_DEEP_LINK_SCHEME}://`;

// Cap the URL we echo into logs. A deep link is fully attacker-controlled (any
// web page can fire one), so a hostile actor could otherwise flood the log with
// a megabyte-long URI. Mirrors `UNTRUSTED_URL_MAX_CHARS` in plugin.ts.
const UNTRUSTED_URL_MAX_CHARS = 200;

function truncateForLog(raw: string): string {
  return raw.length > UNTRUSTED_URL_MAX_CHARS ? `${raw.slice(0, UNTRUSTED_URL_MAX_CHARS)}…` : raw;
}

/**
 * Validate and narrow a raw `daintree://` URI to a {@link PluginDeepLinkIntent},
 * or `null` if it isn't a deep link we recognise. The URL is untrusted; every
 * branch fails closed.
 *
 * Accepted shapes:
 * - `daintree://plugin/install?url=<http(s) archive url>`
 * - `daintree://plugin/open?id=<publisher.name>`
 *
 * The nested install `url` is only required to be `http:`/`https:` here — the
 * full SSRF / private-host / size gates live in `handleInstallFromUrl`, which
 * the renderer routes through when the user presses install. This parser's job
 * is to reject non-web schemes (`javascript:`, `file:`, `daintree:`) so a
 * hostile deep link can't pre-fill the dialog with something dangerous.
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

  if (url.pathname === "/install") {
    const target = url.searchParams.get("url");
    if (!target) return null;
    let nested: URL;
    try {
      nested = new URL(target);
    } catch {
      return null;
    }
    if (nested.protocol !== "https:" && nested.protocol !== "http:") return null;
    return { action: "install", url: target };
  }

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

function primaryAppWebContents(): Electron.WebContents | null {
  const win = windowRegistry?.getPrimary()?.browserWindow;
  if (!win || win.isDestroyed()) return null;
  const wc = getAppWebContents(win);
  return wc && !wc.isDestroyed() ? wc : null;
}

function deliver(webContents: Electron.WebContents, intent: PluginDeepLinkIntent): void {
  try {
    webContents.send(CHANNELS.EVENTS_PUSH, { name: "plugin:deep-link", payload: intent });
  } catch {
    // Send can fail mid-teardown — drop silently, the intent is non-critical.
  }
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
  if (wc && paintedWebContentsIds.has(wc.id)) {
    deliver(wc, intent);
    pendingIntent = null;
  } else {
    pendingIntent = intent;
  }
}

/**
 * Record that an app view has painted and flush any pending deep-link intent to
 * it. Called from the `app:view-painted` IPC handler. Delivering on paint (not
 * on window creation) ensures the renderer's deep-link listener is mounted.
 */
export function notifyAppViewPainted(webContents: Electron.WebContents): void {
  const id = webContents.id;
  paintedWebContentsIds.add(id);
  webContents.once("destroyed", () => paintedWebContentsIds.delete(id));

  if (!pendingIntent) return;
  // Prefer the primary view; fall back to the view that just painted if the
  // primary hasn't painted yet (rare multi-window cold launch).
  const primary = primaryAppWebContents();
  const target = primary && paintedWebContentsIds.has(primary.id) ? primary : webContents;
  deliver(target, pendingIntent);
  pendingIntent = null;
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
}
