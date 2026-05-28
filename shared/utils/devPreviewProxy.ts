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
 * Reduce an arbitrary id to a DNS-label-safe token. Mirrors the `sanitizeToken` used for
 * terminal ids: non-alphanumeric runs collapse to hyphens and the result is capped at 24
 * chars (well under the 63-char DNS label limit, even combined as `dp-<a>-<b>`).
 */
export function sanitizeSubdomainToken(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24) || "x";
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
