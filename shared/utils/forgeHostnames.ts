/**
 * Hostname matching for forge provider routing. Lives in `shared/` so the
 * main-process registry, the workspace host (worktree monitoring), and the
 * renderer (clone dialog, enable-CTA) all match remote URLs against provider
 * `matches` patterns with one implementation.
 */

/**
 * Normalize a hostname for matching: case-insensitive, leading `www.`
 * stripped. Returns `null` for empty/non-string input.
 */
export function normalizeHostname(host: string): string | null {
  if (typeof host !== "string") return null;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed.startsWith("www.") ? trimmed.slice(4) : trimmed;
}

/**
 * Extract a normalized hostname from a git remote URL. Handles SCP form
 * (`user@host:path`), HTTPS, and SSH (`ssh://...`). Returns `null` for
 * malformed input — callers treat that as "no match".
 */
export function extractHostname(url: string): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  // SCP form: `user@host:path` — no scheme, host terminated by the first colon.
  // The `!includes("://")` discriminator distinguishes this from URLs that
  // carry a port (`https://host:443/...`), which never have an SCP shape.
  if (!trimmed.includes("://") && trimmed.includes(":")) {
    const match = /^(?:[^@/:]+@)?([^:/]+):/.exec(trimmed);
    const host = match?.[1];
    return host ? normalizeHostname(host) : null;
  }

  try {
    const parsed = new URL(trimmed);
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Canonical bare hostname for a user-configured forge host (a self-hosted
 * instance a setting names), or `null` when the value is empty or isn't one.
 * Accepts a bare hostname or a pasted `https://` origin; refuses anything a
 * bare hostname can't carry — a scheme other than https, credentials, a port
 * other than 443, a path, query or fragment — because the host builds its own
 * endpoints from the name and a dropped part would point them somewhere else.
 * The result also names the origin a credential is bound to, so a leading
 * `www.` (which {@link normalizeHostname} strips for matching) is refused.
 */
export function normalizeConfiguredForgeHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  // `new URL` repairs some inputs (a trailing `?`, a backslash); refuse the
  // ones it changed beyond case and a bare trailing slash.
  const echoed = withScheme.replace(/\/$/, "").toLowerCase();
  if (echoed !== `https://${parsed.hostname}` && echoed !== `https://${parsed.hostname}:443`) {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  // Matching ignores a leading `www.`, so `www.x` would route remotes on `x`
  // while naming a different origin: refuse it rather than mean either.
  if (hostname.startsWith("www.")) return null;
  return HOSTNAME_PATTERN.test(hostname) ? hostname : null;
}

/** Exact-match a normalized hostname against provider `matches` patterns. */
export function hostnameMatchesAny(hostname: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    const normalized = normalizeHostname(pattern);
    if (normalized !== null && normalized === hostname) return true;
  }
  return false;
}

/**
 * One registered provider's hostname patterns, keyed by canonical provider id
 * (`{pluginId}.{contributionId}`). Relayed from main into workspace hosts so
 * monitors can resolve a remote URL to a provider without registry access.
 */
export interface ForgeProviderMatcher {
  providerId: string;
  hostnames: string[];
}

/**
 * Resolve a remote URL to the first matching provider id from a matcher
 * table, or `null` when no registered provider matches.
 */
export function matchProviderForRemoteUrl(
  remoteUrl: string,
  matchers: readonly ForgeProviderMatcher[]
): string | null {
  const hostname = extractHostname(remoteUrl);
  if (hostname === null) return null;
  for (const matcher of matchers) {
    if (hostnameMatchesAny(hostname, matcher.hostnames)) return matcher.providerId;
  }
  return null;
}
