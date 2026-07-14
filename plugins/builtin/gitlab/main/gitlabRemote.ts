import type { RepoRef } from "../../../../shared/types/forge.js";

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
  const segments = cleanPath(parsed.pathname);
  if (!segments) return null;
  return fromSegments(parsed.hostname, segments);
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

/** Web URL of the project's home page. */
export function repoWebUrl(repo: Pick<RepoRef, "host" | "owner" | "repo">): string {
  return `https://${repo.host}/${repo.owner}/${repo.repo}`;
}
