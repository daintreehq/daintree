import type { RateLimitInfo } from "../../../../shared/types/forge.js";
import {
  GITLAB_API_TIMEOUT_MS,
  getInstanceHostStrict,
  getInstanceUrl,
  getToken,
  getTokenVersion,
  markTokenHealthy,
  markTokenUnhealthy,
} from "./GitLabAuth.js";

/** GitLab REST/GraphQL error with the HTTP status preserved for callers. */
export class GitLabApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitLabApiError";
    this.status = status;
  }
}

export type QueryValue = string | number | boolean | Array<string | number> | undefined;

export interface GitLabRestOptions {
  /** Hostname the repo lives on — resolved to a base URL via {@link apiBaseForHost}. */
  host: string;
  /** Path under `/api/v4`, with a leading slash. */
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  timeoutMs?: number;
}

export interface GitLabRestResult<T> {
  data: T;
  headers: Headers;
}

/** One page of a REST list plus GitLab's offset-pagination headers. */
export interface GitLabRestPage<T> {
  items: T[];
  /** Next page number as an opaque cursor, `null` on the last page. */
  nextCursor: string | null;
  hasMore: boolean;
  totalCount?: number;
}

export interface RateLimitSnapshot {
  info: RateLimitInfo;
  /** Epoch ms the headers were actually observed. */
  fetchedAt: number;
}

/**
 * Last rate-limit snapshot per hostname. Self-managed instances configure
 * their own quotas, so one host's headers must never masquerade as
 * another's.
 */
const rateLimitByHost = new Map<string, RateLimitSnapshot>();

export function getRateLimitSnapshot(host: string): RateLimitSnapshot | null {
  return rateLimitByHost.get(host.toLowerCase()) ?? null;
}

/** Test-isolation helper. */
export function resetLastRateLimitInfo(): void {
  rateLimitByHost.clear();
}

function captureRateLimit(host: string, headers: Headers): void {
  const limit = Number.parseInt(headers.get("ratelimit-limit") ?? "", 10);
  const remaining = Number.parseInt(headers.get("ratelimit-remaining") ?? "", 10);
  const reset = Number.parseInt(headers.get("ratelimit-reset") ?? "", 10);
  if (!Number.isFinite(limit) && !Number.isFinite(remaining)) return;
  rateLimitByHost.set(host.toLowerCase(), {
    info: {
      limit: Number.isFinite(limit) ? limit : null,
      remaining: Number.isFinite(remaining) ? remaining : null,
      resetAt: Number.isFinite(reset) ? reset * 1000 : null,
    },
    fetchedAt: Date.now(),
  });
}

/**
 * Whether the current token may be attached to requests against `host`.
 * The token is scoped to the configured instance (`instanceUrl` setting) —
 * never send it to any other host, even one the user routed to this provider
 * via the per-project override. Fails closed: a broken settings read means
 * no token, not "assume gitlab.com". The token is read AFTER the async
 * settings read so a credential cleared or rotated mid-await is honored.
 */
export async function tokenAllowedForHost(host: string): Promise<string | null> {
  let instanceHost: string;
  try {
    instanceHost = await getInstanceHostStrict();
  } catch {
    return null;
  }
  if (host.toLowerCase() !== instanceHost) return null;
  return getToken();
}

/**
 * Base URL for API calls against `host`. When `host` is the configured
 * instance, the full configured base URL is used so self-hosted installs on
 * a custom scheme, port, or path prefix (`https://code.example:8443/gitlab`)
 * reach the right endpoint. Any other GitLab host (public instances matched
 * by hostname) gets plain `https://` on the default port.
 */
async function apiBaseForHost(host: string): Promise<string> {
  const instanceUrl = await getInstanceUrl();
  try {
    if (new URL(instanceUrl).hostname.toLowerCase() === host.toLowerCase()) {
      return instanceUrl;
    }
  } catch {
    // Unparsable configured URL — fall through to the plain-https default.
  }
  return `https://${host}`;
}

function buildQueryString(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) params.append(`${key}[]`, String(entry));
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    const message = body.message ?? body.error;
    if (typeof message === "string") return message;
    if (message && typeof message === "object") return JSON.stringify(message);
  } catch {
    // Non-JSON error body — fall through to the status line.
  }
  return `GitLab request failed (${response.status})`;
}

/**
 * Perform a GitLab REST v4 request. Attaches the stored token only when the
 * target host matches the configured instance (see {@link tokenAllowedForHost});
 * public projects on other GitLab hosts still work unauthenticated. Captures
 * rate-limit headers per host and folds authoritative 401s into token health
 * (guarded by the token version captured at send time).
 */
export async function gitlabRest<T>(options: GitLabRestOptions): Promise<GitLabRestResult<T>> {
  const token = await tokenAllowedForHost(options.host);
  const base = await apiBaseForHost(options.host);
  const versionAtRequest = getTokenVersion();
  const url = `${base}/api/v4${options.path}${buildQueryString(options.query)}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? GITLAB_API_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GitLabApiError(0, `Couldn't reach ${options.host}: ${(err as Error).message}`);
  }

  captureRateLimit(options.host, response.headers);

  if (response.status === 401 && token) markTokenUnhealthy(versionAtRequest);

  if (!response.ok) {
    throw new GitLabApiError(response.status, await parseErrorMessage(response));
  }

  if (token) markTokenHealthy(versionAtRequest);

  if (response.status === 204) {
    return { data: undefined as T, headers: response.headers };
  }
  const data = (await response.json()) as T;
  return { data, headers: response.headers };
}

/**
 * Fetch one page of a REST list endpoint, translating GitLab's offset
 * pagination headers (`x-next-page`, `x-total`) into the contract's opaque
 * cursor shape. `x-total` is absent above 10k rows on gitlab.com — the page
 * simply carries no `totalCount` then.
 */
export async function gitlabRestPage<T>(options: GitLabRestOptions): Promise<GitLabRestPage<T>> {
  const { data, headers } = await gitlabRest<T[]>(options);
  const nextPage = headers.get("x-next-page") ?? "";
  const total = Number.parseInt(headers.get("x-total") ?? "", 10);
  return {
    items: Array.isArray(data) ? data : [],
    nextCursor: nextPage.length > 0 ? nextPage : null,
    hasMore: nextPage.length > 0,
    ...(Number.isFinite(total) ? { totalCount: total } : {}),
  };
}

/**
 * Perform a GitLab GraphQL request against `{base}/api/graphql`. Same
 * token-attachment rule and health accounting as REST. Returns the `data`
 * payload; GraphQL transport errors and top-level `errors` both throw.
 */
export async function gitlabGraphQL<T>(
  host: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const token = await tokenAllowedForHost(host);
  const base = await apiBaseForHost(host);
  const versionAtRequest = getTokenVersion();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${base}/api/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(GITLAB_API_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GitLabApiError(0, `Couldn't reach ${host}: ${(err as Error).message}`);
  }

  captureRateLimit(host, response.headers);

  if (response.status === 401 && token) markTokenUnhealthy(versionAtRequest);
  if (!response.ok) {
    throw new GitLabApiError(response.status, await parseErrorMessage(response));
  }

  const payload = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (payload.errors && payload.errors.length > 0) {
    throw new GitLabApiError(200, payload.errors[0]?.message ?? "GitLab GraphQL error");
  }
  if (payload.data === undefined || payload.data === null) {
    throw new GitLabApiError(200, "GitLab GraphQL returned no data");
  }
  if (token) markTokenHealthy(versionAtRequest);
  return payload.data;
}
