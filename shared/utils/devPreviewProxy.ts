// Stable-origin reverse proxy for dev-preview panels (#9100).
//
// Every dev-preview panel loads a fixed `dp-<projectToken>-<panelToken>.localhost:<proxyPort>`
// origin instead of the dev server's ephemeral `localhost:<random-port>`. Chromium maps any
// `*.localhost` host to loopback as a Secure Context (no OS DNS, no TLS), so cookies,
// localStorage, and sessionStorage now survive dev-server restarts that reshuffle the upstream
// port. These helpers are the single source of truth for the subdomain shape, shared by the
// main-process proxy/session services and the renderer that builds the webview URL.

/**
 * Default fixed port for the dev-preview reverse proxy. The proxy falls back to an
 * OS-assigned port if this is already bound, so always resolve the live port via the
 * `devPreview.getProxyPort` IPC rather than assuming this constant.
 */
export const DEV_PREVIEW_PROXY_PORT = 43000;

const SUBDOMAIN_PREFIX = "dp-";
const LOCALHOST_SUFFIX = ".localhost";

/**
 * Path the proxy reserves for the "open in real browser" handoff (#9101). The
 * main process mints a short-lived single-use token, builds a URL on the panel's
 * stable origin pointing here, and `shell.openExternal`s it; the proxy validates
 * the token, sets a session cookie, and 302-redirects to the requested path.
 */
export const DEV_PREVIEW_BOOTSTRAP_PATH = "/_daintree/bootstrap";

/**
 * HTTP/1.1 reason phrase the proxy stamps on the 502 it generates itself when the
 * upstream dev server is down or unregistered (#12296). The renderer's only
 * renderer-side view of a response status is `did-frame-navigate`, which carries
 * `httpResponseCode` and `httpStatusText` but no headers — so the reason phrase is
 * how a proxy-generated 502 announces its provenance. Chromium preserves an
 * arbitrary HTTP/1.1 reason phrase verbatim, and the proxy is a plain Node `http`
 * server, so this survives the round trip. A 502 forwarded from the developer's own
 * app carries that app's reason phrase instead and must render normally.
 */
export const DEV_PREVIEW_PROXY_STATUS_TEXT = "Daintree Preview Proxy Upstream Unavailable";

/**
 * Reduce an arbitrary id to a DNS-label-safe token: lowercased, every character outside
 * `[a-z0-9-]` collapsed to a hyphen, capped at 24 chars (well under the 63-char DNS label
 * limit, even combined as `dp-<a>-<b>`). Lowercasing is essential, not cosmetic — hostnames
 * are case-insensitive, so the browser sends the `Host` header lowercased; building the
 * subdomain in any other case would make the proxy's subdomain→port lookup miss. Underscores
 * are folded too since they aren't valid in RFC 1123 DNS labels.
 */
export function sanitizeSubdomainToken(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 24) || "x"
  );
}

/**
 * Build the stable subdomain label for a dev-preview panel: `dp-<projectToken>-<panelToken>`.
 * Deterministic per (projectId, panelId), so the same panel always resolves to the same origin.
 */
export function buildDevPreviewSubdomain(projectId: string, panelId: string): string {
  return `${SUBDOMAIN_PREFIX}${sanitizeSubdomainToken(projectId)}-${sanitizeSubdomainToken(panelId)}`;
}

/**
 * Build the full stable origin a dev-preview webview should load, e.g.
 * `http://dp-myproj-panel1.localhost:43000`. Plain HTTP — `*.localhost` is a Secure Context.
 */
export function buildDevPreviewProxyOrigin(
  proxyPort: number,
  projectId: string,
  panelId: string
): string {
  return `http://${buildDevPreviewSubdomain(projectId, panelId)}.localhost:${proxyPort}`;
}

/**
 * Extract the dev-preview subdomain label from an incoming `Host` header (e.g.
 * `dp-myproj-panel1.localhost:43000` -> `dp-myproj-panel1`). Returns null for any host that is
 * not a `dp-*.localhost` subdomain, so the proxy can reject unrelated requests with a 502.
 */
export function parseDevPreviewProxyHost(host: string | undefined | null): string | null {
  if (!host) return null;
  // Strip the optional `:port`. Bracketed IPv6 hosts ([::1]) never match the suffix below,
  // so the naive split is safe for the only hosts the proxy actually serves.
  const hostname = host.split(":")[0]?.trim().toLowerCase() ?? "";
  if (!hostname.endsWith(LOCALHOST_SUFFIX)) return null;
  const label = hostname.slice(0, -LOCALHOST_SUFFIX.length);
  if (!label || !label.startsWith(SUBDOMAIN_PREFIX)) return null;
  return label;
}

/**
 * Coerce an untrusted redirect target into a safe same-origin absolute path,
 * defaulting to `/` for anything unsafe so the bootstrap handoff (#9101) can
 * never become an open redirect. Rejects (→ `/`): empty input, paths missing a
 * leading `/`, and scheme-relative `//` or `/\` forms that browsers resolve to
 * a different origin. Validation rounds the path through the URL constructor —
 * string-prefix checks alone miss encoded bypasses (see #4702). The returned
 * value preserves the path + query + fragment of a valid input.
 */
export function normalizeBootstrapRedirectPath(input: string | undefined | null): string {
  if (!input || !input.startsWith("/") || input.startsWith("//") || input.startsWith("/\\")) {
    return "/";
  }
  try {
    const resolved = new URL(input, "http://dp.localhost");
    if (resolved.origin !== "http://dp.localhost") return "/";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}

/**
 * Build the full bootstrap URL the system browser should open for a panel's
 * stable origin (#9101): `<origin>/_daintree/bootstrap?token=<t>&rd=<path>`.
 * `rd` is included only as a fast-fail hint — the proxy reads the authoritative
 * redirect target from the signed token payload, not this query param.
 */
export function buildBootstrapUrl(origin: string, token: string, redirectPath: string): string {
  const params = new URLSearchParams({ token, rd: redirectPath });
  return `${origin}${DEV_PREVIEW_BOOTSTRAP_PATH}?${params.toString()}`;
}
