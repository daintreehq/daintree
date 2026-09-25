import { extractHostname } from "./forgeHostnames.js";

/**
 * Forges whose owner and repository names are case-insensitive, so
 * `GitHub.com/Owner/Repo` and `github.com/owner/repo` are one repository.
 * Anywhere else a path's case may be significant and is kept.
 */
const CASE_INSENSITIVE_FORGES = new Set(["github.com", "gitlab.com"]);

/** Hostnames that are another spelling of a forge above (GitHub's SSH-over-443 endpoint). */
const HOST_ALIASES: Record<string, string> = { "ssh.github.com": "github.com" };

const DEFAULT_PORTS: Record<string, string> = {
  "ssh:": "22",
  "git+ssh:": "22",
  "ssh+git:": "22",
  "https:": "443",
  "http:": "80",
  "git:": "9418",
};

const NETWORK_SCHEMES = new Set(Object.keys(DEFAULT_PORTS));

function cleanPath(raw: string): string | null {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A stray `%` is part of the name, not an escape.
  }
  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const last = segments.length - 1;
  segments[last] = segments[last]!.replace(/\.git$/i, "");
  if (segments[last]!.length === 0) segments.pop();
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function canonicalHost(host: string): string {
  return HOST_ALIASES[host] ?? host;
}

/**
 * Reduce a git remote to `host[:port]/path` so the same repository spelled
 * over SSH (`git@host:owner/repo`, `ssh://…`) and HTTPS compares equal. User
 * info, the `.git` suffix, default ports and stray slashes are dropped; path
 * case is folded only on forges known to ignore it; nested groups are kept.
 *
 * Returns null for anything that doesn't name a network remote (a local path,
 * `file://`, or garbage): those can't identify a repository across machines.
 */
export function normalizeGitRemoteUrl(url: string): string | null {
  const parsed = parseRemote(url);
  if (!parsed) return null;
  const pathPart = CASE_INSENSITIVE_FORGES.has(parsed.host)
    ? parsed.path.toLowerCase()
    : parsed.path;
  return `${parsed.host}${parsed.port ? `:${parsed.port}` : ""}/${pathPart}`;
}

function parseRemote(url: string): { host: string; port: string; path: string } | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 4096) return null;

  let host: string | null;
  let port = "";
  let rawPath: string;

  if (!trimmed.includes("://")) {
    // SCP form: `[user@]host:path`. A bare path (`/srv/repo`, `./repo`) or a
    // Windows drive path (`C:\repo`) has no host.
    if (/^[A-Za-z]:[\\/]/.test(trimmed)) return null;
    const match = /^(?:[^@/:]+@)?([^:/]+):(.*)$/.exec(trimmed);
    if (!match) return null;
    host = extractHostname(trimmed);
    rawPath = match[2] ?? "";
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    const scheme = parsed.protocol.toLowerCase();
    if (!NETWORK_SCHEMES.has(scheme)) return null;
    host = extractHostname(trimmed);
    if (parsed.port && parsed.port !== DEFAULT_PORTS[scheme]) port = parsed.port;
    rawPath = parsed.pathname;
  }

  if (!host) return null;
  host = canonicalHost(host);
  // GitHub's SSH-over-HTTPS endpoint is the same repository on port 443.
  if (host === "github.com" && port === "443") port = "";

  const cleaned = cleanPath(rawPath);
  if (!cleaned) return null;
  return { host, port, path: cleaned };
}

/** Every normalised form among `urls`, without duplicates or unparseable entries. */
export function normalizeGitRemoteUrls(urls: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const url of urls) {
    const normalized = normalizeGitRemoteUrl(url);
    if (normalized) out.add(normalized);
  }
  return out;
}

/** The normalised remotes `a` and `b` have in common. */
export function sharedGitRemotes(a: Iterable<string>, b: Iterable<string>): string[] {
  const left = normalizeGitRemoteUrls(a);
  const shared: string[] = [];
  for (const normalized of normalizeGitRemoteUrls(b)) {
    if (left.has(normalized)) shared.push(normalized);
  }
  return shared;
}

/** The last path segment of a remote: the repository's own name, for a default folder. */
export function repositoryNameFromRemote(url: string): string | null {
  const parsed = parseRemote(url);
  if (!parsed) return null;
  const segments = parsed.path.split("/");
  return segments[segments.length - 1] || null;
}

/** Remotes a clone accepts: HTTP(S), SCP-style SSH (`git@host:path`) and `ssh://`. */
export function isSupportedCloneUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || /^git@/i.test(url) || /^ssh:\/\//i.test(url);
}
