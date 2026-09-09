import type { RateLimitInfo } from "../../../../shared/types/forge.js";
import {
  GITLAB_API_TIMEOUT_MS,
  getInstanceUrlStrict,
  getToken,
  getTokenVersion,
  markTokenHealthy,
  markTokenUnhealthy,
  tokenMatchesInstance,
} from "./GitLabAuth.js";

/** GitLab REST/GraphQL error with the HTTP status preserved for callers. */
export class GitLabApiError extends Error {
  readonly status: number;
  /**
   * Epoch ms an active rate-limit block lifts, when a 429 said so. Callers
   * that render a "back at" banner read this rather than re-deriving it from
   * the message.
   */
  readonly rateLimitResetAt: number | undefined;

  constructor(status: number, message: string, rateLimitResetAt?: number) {
    super(message);
    this.name = "GitLabApiError";
    this.status = status;
    this.rateLimitResetAt = rateLimitResetAt;
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

/**
 * One coherent decision about a request: where it goes, what credential it
 * carries, and the token version that credential was read at. All three come
 * from a single settings read so they cannot disagree with each other.
 */
export interface RequestAuth {
  /** API base, including the configured scheme, port, and deployment path. */
  base: string;
  token: string | null;
  version: number;
}

export function getRateLimitSnapshot(host: string): RateLimitSnapshot | null {
  return rateLimitByHost.get(host.toLowerCase()) ?? null;
}

/** Test-isolation helper. */
export function resetLastRateLimitInfo(): void {
  rateLimitByHost.clear();
}

/**
 * Drop observed quotas. Called on invalidation because a quota belongs to an
 * account on an instance: after a credential or instance change, the previous
 * account's exhausted quota would keep the host's polling gate shut.
 */
export function resetRateLimitSnapshots(): void {
  rateLimitGeneration += 1;
  rateLimitByHost.clear();
}

/**
 * Bumped by {@link resetRateLimitSnapshots}. A request in flight when the
 * credential or instance changed carries the PREVIOUS account's quota
 * headers; recording them would leave the host's polling gate shut on a quota
 * the new account never spent.
 */
let rateLimitGeneration = 0;

function captureRateLimit(host: string, headers: Headers, epoch: number): void {
  if (epoch !== rateLimitGeneration) return;
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
export async function resolveRequestAuth(host: string): Promise<RequestAuth> {
  const version = getTokenVersion();
  let instanceUrl: string | null;
  try {
    instanceUrl = await getInstanceUrlStrict();
  } catch {
    // The configured instance is unknowable, so neither the destination nor
    // the authorization decision can be made. Public hosts still work.
    return { base: `https://${host}`, token: null, version };
  }
  let instanceHost: string;
  try {
    instanceHost = new URL(instanceUrl).hostname.toLowerCase();
  } catch {
    return { base: `https://${host}`, token: null, version };
  }
  // Not the configured instance: a public GitLab host reached over plain
  // https, unauthenticated.
  if (host.toLowerCase() !== instanceHost) {
    return { base: `https://${host}`, token: null, version };
  }
  // Destination and authorization come from THE SAME read. Resolving them
  // separately lets the second read fail and send the token to a fallback
  // origin — dropping the configured port and deployment path — after the
  // first read already approved it for the real one.
  const token = tokenMatchesInstance(instanceUrl) ? getToken() : null;
  // Token and version are read with no await between them, so a rotation
  // can't stamp the new version onto the old token's outcome.
  return { base: instanceUrl, token, version: getTokenVersion() };
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

/**
 * When a throttle lifts, in epoch ms, from a 429's own headers. GitLab's two
 * limiters answer differently: the Rack::Attack throttles send `Retry-After`
 * (seconds) alongside `RateLimit-Reset` (epoch seconds), while the
 * application rate limiter sends `Retry-After` only. Read both so either one
 * yields a real resume time; `undefined` when neither header is usable.
 */
function rateLimitResetAtFrom(headers: Headers): number | undefined {
  const retryAfter = Number.parseInt(headers.get("retry-after") ?? "", 10);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Date.now() + retryAfter * 1000;
  const reset = Number.parseInt(headers.get("ratelimit-reset") ?? "", 10);
  if (Number.isFinite(reset) && reset > 0) return reset * 1000;
  return undefined;
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
  const rateLimitEpoch = rateLimitGeneration;
  const { base, token, version: versionAtRequest } = await resolveRequestAuth(options.host);
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

  captureRateLimit(options.host, response.headers, rateLimitEpoch);

  if (response.status === 401 && token) markTokenUnhealthy(versionAtRequest);

  if (!response.ok) {
    throw new GitLabApiError(
      response.status,
      await parseErrorMessage(response),
      response.status === 429 ? rateLimitResetAtFrom(response.headers) : undefined
    );
  }

  if (response.status === 204) {
    if (token) markTokenHealthy(versionAtRequest);
    return { data: undefined as T, headers: response.headers };
  }

  // An SSO gateway or captive portal answers 200 with an HTML login page. That
  // is not a GitLab response, so it must neither certify the token as healthy
  // nor surface as a bare SyntaxError from the JSON parse.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new GitLabApiError(
      response.status,
      `${options.host} didn't answer with JSON — a sign-in gateway may be intercepting the API`
    );
  }
  let data: T;
  try {
    data = (await response.json()) as T;
  } catch {
    throw new GitLabApiError(response.status, `${options.host} returned an unreadable response`);
  }

  if (token) markTokenHealthy(versionAtRequest);
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
  // A 200 carrying an object (an error envelope, a gateway page that happened
  // to be JSON) is not an empty page. Reporting it as one tells the user the
  // project has no issues.
  if (!Array.isArray(data)) {
    throw new GitLabApiError(200, `${options.host} returned an unexpected list payload`);
  }
  return {
    items: data,
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
  const rateLimitEpoch = rateLimitGeneration;
  const { base, token, version: versionAtRequest } = await resolveRequestAuth(host);
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

  captureRateLimit(host, response.headers, rateLimitEpoch);

  if (response.status === 401 && token) markTokenUnhealthy(versionAtRequest);
  if (!response.ok) {
    throw new GitLabApiError(
      response.status,
      await parseErrorMessage(response),
      response.status === 429 ? rateLimitResetAtFrom(response.headers) : undefined
    );
  }

  // Same case the REST transport guards: an SSO gateway or captive portal
  // answers 200 with an HTML sign-in page, which must surface as a
  // GitLabApiError rather than a bare SyntaxError out of the JSON parse.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new GitLabApiError(
      response.status,
      `${host} didn't answer with JSON — a sign-in gateway may be intercepting the API`
    );
  }
  let payload: { data?: T; errors?: Array<{ message?: string }> };
  try {
    payload = (await response.json()) as {
      data?: T;
      errors?: Array<{ message?: string }>;
    };
  } catch {
    throw new GitLabApiError(response.status, `${host} returned an unreadable response`);
  }
  if (payload.errors && payload.errors.length > 0) {
    throw new GitLabApiError(200, payload.errors[0]?.message ?? "GitLab GraphQL error");
  }
  if (payload.data === undefined || payload.data === null) {
    throw new GitLabApiError(200, "GitLab GraphQL returned no data");
  }
  if (token) markTokenHealthy(versionAtRequest);
  return payload.data;
}
