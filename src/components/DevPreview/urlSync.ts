import { normalizeBrowserUrl, isLocalhostUrl, type NormalizeResult } from "../Browser/browserUtils";

/**
 * Copy the route (path + query + fragment) of `from` onto `origin`, returning the
 * absolute URL. Field assignment rather than string concatenation so an encoded
 * path or a `//`-prefixed pathname can never be reparsed as a new authority.
 */
function graftRouteOntoOrigin(origin: URL, from: URL): string {
  const target = new URL(origin.toString());
  target.pathname = from.pathname;
  target.search = from.search;
  target.hash = from.hash;
  return target.toString();
}

function parseOrNull(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** True when `url` sits on exactly `origin`. Parsed comparison, not `startsWith`: a
 * prefix test would accept `…localhost:43000` as a match for `…localhost:4300`. */
export function isOnOrigin(url: string, origin: string): boolean {
  const parsed = parseOrNull(url);
  const parsedOrigin = parseOrNull(origin);
  return !!parsed && !!parsedOrigin && parsed.origin === parsedOrigin.origin;
}

/**
 * Address-bar/navigation policy for a dev-preview panel (#12297).
 *
 * Dev Preview used to normalize with no options, which takes `normalizeBrowserUrl`'s
 * strict branch and accepts only the bare loopback hosts — so the panel rejected the
 * very `dp-*.localhost` origin it was itself displaying. The fix is a policy that
 * accepts exactly two things and nothing else:
 *
 *  - a bare loopback URL (what already worked), and
 *  - **this panel's own** proxy origin. `isDevPreviewProxyUrl` is deliberately not
 *    used here: it is a shape check that passes any `*.localhost` subdomain, which
 *    would let one panel drive another panel's origin.
 *
 * Everything else — LAN/private hosts, arbitrary `.localhost`/`.test` names, public
 * hosts, non-HTTP protocols — is rejected outright rather than returned with
 * `requiresConfirmation`, since a dev preview has no host-approval flow to fall into.
 *
 * In configured proxy mode a loopback URL is retargeted onto the proxy origin,
 * preserving path, query and fragment, so a typed raw-upstream address never lands
 * the pane off-origin and back through the migration/remount dance.
 */
export function normalizeDevPreviewUrl(
  rawUrl: string,
  proxyOrigin: string | null | undefined
): NormalizeResult {
  // Extended mode (empty allow-list) parses `*.localhost` instead of erroring on it;
  // the allow-list below, not this call, is what authorizes the result.
  const normalized = normalizeBrowserUrl(rawUrl, { allowedHosts: [] });
  if (normalized.error || !normalized.url) {
    return { error: normalized.error ?? "Invalid URL format" };
  }

  const parsed = parseOrNull(normalized.url);
  if (!parsed) return { error: "Invalid URL format" };

  const proxy = typeof proxyOrigin === "string" ? parseOrNull(proxyOrigin) : null;

  if (isLocalhostUrl(normalized.url)) {
    return proxy ? { url: graftRouteOntoOrigin(proxy, parsed) } : { url: normalized.url };
  }

  if (proxy && parsed.origin === proxy.origin) {
    return { url: normalized.url };
  }

  return { error: `Only localhost URLs are allowed (got "${parsed.hostname}")` };
}

/**
 * Decides whether a freshly detected dev-server URL should replace the URL the
 * pane is currently showing, and if so, what URL to navigate to.
 *
 * Returns `false` when no adoption is needed (no detected URL, or the detected
 * URL is the same origin the pane is already on — a port-stable restart).
 *
 * **Proxy mode (#9100):** when `proxyOrigin` is supplied, the webview always sits
 * on the stable `dp-*.localhost` proxy origin and never moves off it. A dev-server
 * restart only shifts the upstream port — which the proxy resolves live — so once
 * the pane is on the proxy origin there is nothing to navigate (returns `false`).
 * The only navigation is the first one onto the proxy origin (and any migration
 * off a stale direct-localhost URL), where the route is taken from the pane's own
 * current route, else the detected URL's non-root path, else `/`. A route the pane
 * already holds outranks an advertised base: on a *migration* that route is where
 * the user or the app asked to be, and overwriting it with the dev server's base
 * is how the destination got lost (#12297). The base still wins on first adoption,
 * when there is no current route to defend.
 *
 * **Legacy mode (no proxy):** when the dev server restarts on a different origin
 * (typically a port shift, e.g. 3000 → 3001), the detected URL is the bare server
 * root. Navigating to it directly would drop the route the user was on; to preserve
 * it, the current URL's pathname/search/hash are grafted onto the detected origin.
 * If the detected URL itself carries a non-root path (e.g. a Vite `base` config
 * advertising `http://localhost:5174/app/`), that path is intentional and is
 * navigated to as-is — grafting only applies to a bare server root.
 */
export function computeDevServerUrl(
  detectedUrl: string,
  currentUrl: string,
  proxyOrigin?: string | null
): string | false {
  if (!detectedUrl) return false;

  if (proxyOrigin) {
    let proxy: URL;
    try {
      proxy = new URL(proxyOrigin);
    } catch {
      return false;
    }
    let current: URL | null;
    try {
      current = currentUrl ? new URL(currentUrl) : null;
    } catch {
      current = null;
    }
    // Already on the stable proxy origin — a restart only moved the upstream port,
    // which the proxy follows transparently. Nothing to navigate.
    if (current && current.origin === proxy.origin) return false;

    // First navigation onto the proxy origin (or migrating off a stale localhost
    // URL). Choose the route: preserve the pane's current route, else honor a
    // non-root path the dev server advertises (Vite `base`), else land on root.
    if (current && (current.pathname !== "/" || !!current.search || !!current.hash)) {
      return graftRouteOntoOrigin(proxy, current);
    }
    const detected = parseOrNull(detectedUrl);
    if (detected && detected.pathname !== "/") return graftRouteOntoOrigin(proxy, detected);
    return proxy.toString();
  }

  if (!currentUrl) return detectedUrl;
  if (detectedUrl === currentUrl) return false;

  let detected: URL;
  let current: URL;
  try {
    detected = new URL(detectedUrl);
    current = new URL(currentUrl);
  } catch {
    // Fall forward to the detected URL if either URL cannot be parsed.
    return detectedUrl;
  }

  if (detected.origin === current.origin) return false;

  // The detected URL advertises its own non-root path (e.g. a Vite `base`).
  // Respect it rather than grafting the user's route onto a different base.
  if (detected.pathname !== "/") return detected.toString();

  // Origin changed (port shift) and the detected URL is a bare root. Graft the
  // user's current route onto the new origin so a dev-server restart doesn't
  // kick them back to the root.
  detected.pathname = current.pathname;
  detected.search = current.search;
  detected.hash = current.hash;
  return detected.toString();
}
