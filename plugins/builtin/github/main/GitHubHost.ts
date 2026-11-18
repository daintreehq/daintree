import { GITHUB_COM_HOST, normalizeEnterpriseHost } from "../shared/githubHost.js";

export { GITHUB_COM_HOST } from "../shared/githubHost.js";

/**
 * The configured GitHub Enterprise Server host, mirrored from the
 * `enterpriseHost` setting at activation and on every change. Synchronous
 * because remote parsing and the URL builders can't await a settings read.
 */
let enterpriseHost: string | null = null;

export function getEnterpriseHost(): string | null {
  return enterpriseHost;
}

/** Mirror a new `enterpriseHost` setting value; anything that isn't a valid host clears it. */
export function setEnterpriseHost(raw: unknown): void {
  enterpriseHost = normalizeEnterpriseHost(raw);
}

/** Whether this provider serves `host` right now: github.com, or the configured enterprise host. */
export function isServedGitHubHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === GITHUB_COM_HOST || (enterpriseHost !== null && normalized === enterpriseHost)
  );
}

function servedHost(host: string): string {
  const normalized = host.toLowerCase();
  if (!isServedGitHubHost(normalized)) {
    throw new Error(`${host} isn't a GitHub host Daintree is set up for`);
  }
  return normalized;
}

/**
 * REST API base for a served host, without a trailing slash. Throws for any
 * other host: an endpoint is only ever built for a host a token can be bound to.
 */
export function githubApiBase(host: string): string {
  const served = servedHost(host);
  return served === GITHUB_COM_HOST ? "https://api.github.com" : `https://${served}/api/v3`;
}

/**
 * The `baseUrl` `@octokit/graphql` appends `/graphql` to: `api.github.com`
 * on github.com, `/api` on Enterprise Server (whose GraphQL endpoint is
 * `/api/graphql`, not under `/api/v3`).
 */
export function githubGraphqlBase(host: string): string {
  const served = servedHost(host);
  return served === GITHUB_COM_HOST ? "https://api.github.com" : `https://${served}/api`;
}

/** Web origin for a served host's repository pages. */
export function githubWebBase(host: string): string {
  return `https://${servedHost(host)}`;
}

/** The host an API URL addresses, or `null` when it is no GitHub API endpoint this provider builds. */
export function apiHostOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "api.github.com") return GITHUB_COM_HOST;
  if (parsed.pathname === "/api" || parsed.pathname.startsWith("/api/")) return hostname;
  return null;
}

/**
 * Whether `url` is on `host`'s exact API origin: `https://api.github.com` for
 * github.com, `https://<host>` under `/api` for an Enterprise Server. A port,
 * another scheme or another hostname never qualifies.
 */
export function isApiUrlFor(url: string, host: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const normalized = host.toLowerCase();
  if (normalized === GITHUB_COM_HOST) return parsed.origin === "https://api.github.com";
  return (
    parsed.origin === `https://${normalized}` &&
    (parsed.pathname === "/api" || parsed.pathname.startsWith("/api/"))
  );
}

/** Test-only reset of the mirrored host. */
export function _resetEnterpriseHostForTests(): void {
  enterpriseHost = null;
}
