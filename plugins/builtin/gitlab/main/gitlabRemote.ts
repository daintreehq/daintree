import type { RepoRef } from "../../../../shared/types/forge.js";
import { getCachedInstanceUrl } from "./GitLabAuth.js";

/**
 * The configured instance base as `{ host, prefix }`, or null when no setting
 * has been read yet. `prefix` is the deployment path a relative install sits
 * under (`https://code.example:8443/gitlab` → `/gitlab`), normalized without a
 * trailing slash. Read from the synchronous cache because the contract's
 * `parseRemote` and URL builders can't await the setting.
 */
function configuredInstance(): { origin: string; host: string; prefix: string } | null {
  const configured = getCachedInstanceUrl();
  if (configured === null) return null;
  try {
    const url = new URL(configured);
    return {
      origin: url.origin,
      host: url.hostname.toLowerCase(),
      prefix: url.pathname.replace(/\/+$/, ""),
    };
  } catch {
    return null;
  }
}

/**
 * Parsed identity of a GitLab repository. GitLab nests projects in subgroups
 * up to 20 levels deep, so `owner` is the full namespace path
 * (`group/subgroup/…`) and `repo` the final project segment. The REST `:id`
 * and GraphQL `fullPath` forms both derive from `${owner}/${repo}`.
 */
export interface ParsedGitLabRemote {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Path segments that can never start a project namespace on a GitLab web
 * host. A remote URL is the only input here so the list stays minimal —
 * these appear when a user pastes a non-repo GitLab URL (an MR page, an API
 * URL) instead of a clone URL.
 */
const RESERVED_LEADING_SEGMENTS = new Set(["api", "-", "uploads", "help"]);

function cleanPath(rawPath: string): string[] | null {
  let path = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  if (path.length === 0) return null;
  const segments = path.split("/").filter((s) => s.length > 0);
  // A GitLab project path is at least `namespace/project`.
  if (segments.length < 2) return null;
  if (RESERVED_LEADING_SEGMENTS.has(segments[0].toLowerCase())) return null;
  // Web URLs (not clone URLs) carry `/-/` route separators — cut there so a
  // pasted MR/issue URL still resolves to its project.
  const dashIndex = segments.indexOf("-");
  const projectSegments = dashIndex > 1 ? segments.slice(0, dashIndex) : segments;
  if (projectSegments.length < 2) return null;
  return projectSegments;
}

function fromSegments(host: string, segments: string[]): ParsedGitLabRemote {
  return {
    host: host.toLowerCase(),
    owner: segments.slice(0, -1).join("/"),
    repo: segments[segments.length - 1],
  };
}

/**
 * Parse a git remote URL into a GitLab repo identity. Deliberately
 * host-agnostic: hostname routing already happened (manifest `matches`, the
 * per-project provider override, or the global default) before the host calls
 * `parseRemote`, so any self-hosted GitLab domain parses here and the REST
 * base URL derives from the returned `host`.
 *
 * Handles the clone-URL forms git produces: SCP-ish `git@host:group/repo.git`,
 * `ssh://git@host[:port]/group/repo.git`, `http(s)://host/group/repo(.git)`,
 * and bare `host/group/repo` pastes. Nested subgroups are preserved in
 * `owner`.
 */
export function parseGitLabRemoteUrl(url: string): ParsedGitLabRemote | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  // SCP-like syntax: [user@]host:path (no scheme, single colon, no leading //).
  const scpMatch = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(trimmed);
  if (scpMatch && !trimmed.includes("://")) {
    const segments = cleanPath(scpMatch[2]);
    if (!segments) return null;
    return fromSegments(scpMatch[1], segments);
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (!parsed.hostname) return null;
  // A relative install serves clone URLs under its deployment path
  // (`https://code.example:8443/gitlab/team/app.git`). That prefix is part of
  // the URL, not of the project namespace — leaving it in would ask the API
  // for project `gitlab/team/app` under a base that already includes
  // `/gitlab`, and 404 on a project that exists.
  const segments = cleanPath(
    stripInstancePrefix(parsed.protocol, parsed.hostname, parsed.pathname)
  );
  if (!segments) return null;
  return fromSegments(parsed.hostname, segments);
}

/**
 * Only HTTP(S) clone URLs carry the deployment prefix — it is a web-server
 * mount point. SSH remotes address the git service directly, so their path IS
 * the namespace: stripping there would turn a genuine `gitlab/team/app`
 * project into `team/app`.
 */
function stripInstancePrefix(protocol: string, host: string, pathname: string): string {
  if (protocol !== "http:" && protocol !== "https:") return pathname;
  const instance = configuredInstance();
  if (!instance || instance.prefix.length === 0) return pathname;
  if (host.toLowerCase() !== instance.host) return pathname;
  const prefix = instance.prefix;
  if (pathname === prefix) return "";
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname;
}

/**
 * Origin (scheme, host, port) the instance is served on, for absolutizing the
 * relative paths GitLab returns. Falls back to plain https for any host that
 * isn't the configured instance.
 */
export function instanceOriginFor(host: string): string {
  const instance = configuredInstance();
  return instance && instance.host === host.toLowerCase() ? instance.origin : `https://${host}`;
}

/** Full namespace path (`group/subgroup/project`) for a parsed repo. */
export function repoFullPath(repo: Pick<RepoRef, "owner" | "repo">): string {
  return `${repo.owner}/${repo.repo}`;
}

/**
 * URL-encoded project id for REST `/projects/:id` routes. The whole path is
 * a single path segment, so every `/` must encode as `%2F`.
 */
export function encodeProjectId(repo: Pick<RepoRef, "owner" | "repo">): string {
  return encodeURIComponent(repoFullPath(repo));
}

/**
 * Web URL of the project's home page. Built from the configured instance base
 * when the repo lives on it, so a self-hosted install on a custom port or
 * under a deployment path keeps both — `https://<host>/…` would drop them and
 * hand the user a dead link. Any other GitLab host (hostname-matched public
 * instances) gets plain https, which is what those serve.
 */
export function repoWebUrl(repo: Pick<RepoRef, "host" | "owner" | "repo">): string {
  const instance = configuredInstance();
  const base =
    instance && instance.host === repo.host.toLowerCase()
      ? `${instance.origin}${instance.prefix}`
      : `https://${repo.host}`;
  return `${base}/${repo.owner}/${repo.repo}`;
}
