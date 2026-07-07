import ipaddr from "ipaddr.js";

/**
 * Dependency-light plugin identifier patterns and hostname classification.
 *
 * These live apart from `./plugin.ts` on purpose: several boot-path modules
 * (deep-link install, plugin IPC handlers, download policy, settings manager)
 * need only these helpers, and importing them from `plugin.ts` dragged its
 * ~96 module-eval zod schemas plus `semver` into the eager main-process
 * graph. Keep this module free of zod/semver.
 */

export const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export const SCOPED_PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Hostnames that resolve to private/loopback/link-local space and must not
 * appear in a plugin's `scopes.network.allowedUrls`. Literal-string matches
 * only — DNS rebinding (a public hostname that resolves to RFC1918 at
 * request time) is out of scope for manifest-level validation. See #9247.
 */
// "0.0.0.0" is a Linux/Unix synonym for "any local interface" and routes to
// loopback on many platforms — it must be rejected alongside "localhost".
// Trailing-FQDN-dot variants (e.g. "localhost.") are normalized away before
// the literal check (see `normalizeHostname` below) so we only list bare forms.
const PRIVATE_LOOPBACK_HOSTNAME_LITERALS = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "0.0.0.0",
]);
/** IPv4 loopback (127.0.0.0/8). */
const IPV4_LOOPBACK_REGEX = /^127\./;
/** IPv4 link-local (169.254.0.0/16). Catches the AWS metadata endpoint. */
const IPV4_LINK_LOCAL_REGEX = /^169\.254\./;
/** IPv4 RFC1918 10.0.0.0/8. */
const IPV4_RFC1918_TEN_REGEX = /^10\./;
/** IPv4 RFC1918 192.168.0.0/16. */
const IPV4_RFC1918_192_REGEX = /^192\.168\./;
/** IPv4 RFC1918 172.16.0.0/12 (172.16.* through 172.31.*). */
const IPV4_RFC1918_172_REGEX = /^172\.(1[6-9]|2\d|3[0-1])\./;

function normalizeHostname(hostname: string): string {
  // WHATWG URL parsing preserves trailing FQDN dots (RFC 1034 §3.1): the host
  // "localhost." is structurally identical to "localhost" but would skip a
  // literal-set check. Strip the trailing dot before any classification.
  return hostname.replace(/\.$/, "").toLowerCase();
}

/**
 * Classify an IPv6 literal. `new URL("https://[::1]").hostname` is `"[::1]"`
 * — WHATWG retains the brackets — so strip them before parsing. Returns true
 * for loopback (::1), link-local (fe80::/10), unique-local (fc00::/7), and
 * IPv4-mapped addresses that unwrap to a blocked IPv4 (e.g. ::ffff:127.0.0.1).
 */
function isPrivateOrLoopbackIPv6(normalized: string): boolean {
  const literal =
    normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
  if (!ipaddr.IPv6.isValid(literal)) return false;
  const addr = ipaddr.IPv6.parse(literal);
  if (addr.isIPv4MappedAddress()) {
    return isPrivateOrLoopbackIPv4(addr.toIPv4Address().toString());
  }
  const range = addr.range();
  return range === "loopback" || range === "linkLocal" || range === "uniqueLocal";
}

function isPrivateOrLoopbackIPv4(value: string): boolean {
  return (
    IPV4_LOOPBACK_REGEX.test(value) ||
    IPV4_LINK_LOCAL_REGEX.test(value) ||
    IPV4_RFC1918_TEN_REGEX.test(value) ||
    IPV4_RFC1918_192_REGEX.test(value) ||
    IPV4_RFC1918_172_REGEX.test(value)
  );
}

export function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (PRIVATE_LOOPBACK_HOSTNAME_LITERALS.has(normalized)) return true;
  if (isPrivateOrLoopbackIPv4(normalized)) return true;
  if (isPrivateOrLoopbackIPv6(normalized)) return true;
  return false;
}
