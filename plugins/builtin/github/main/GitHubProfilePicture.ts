import { Cache } from "../../../../electron/utils/cache.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../../../shared/utils/forgeProviderIds.js";
import type { ProfilePictureProvider } from "../../../../shared/types/profilePictureProvider.js";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS, rateLimitAwareFetch } from "./GitHubAuth.js";
import { GitHubRateLimitError } from "./GitHubRateLimitService.js";

/**
 * GitHub {@link ProfilePictureProvider} — resolves a commit-author email to
 * the author's GitHub avatar URL via the Search Users API (#8514).
 *
 * `in:email` only matches users whose email is *public* on their GitHub
 * profile, so `null` is the common, expected result — callers fall through
 * to the next avatar tier (Gravatar → initials).
 *
 * A TTL cache plus a singleflight map keep the Search API's tight 30 req/min
 * authenticated bucket safe even when a project has many worktree cards
 * sharing one committer:
 *
 * - `avatarCache` stores resolved URLs *and* genuine `null` misses. Caching
 *   the miss is deliberate — most emails have no public profile and we must
 *   not re-hit the API for them every render.
 * - `inflight` deduplicates concurrent lookups for the same email so 10 cards
 *   mounting at once issue a single HTTP request, not 10.
 *
 * Transient outcomes (no token yet, rate-limited, network/5xx error) resolve
 * to `null` for the caller but are deliberately *not* cached, so the very
 * next render retries instead of being pinned to a generic identicon for the
 * full 3-hour TTL.
 */

/** A few hours — profile pictures change rarely and the cache is per-process. */
const AVATAR_CACHE_TTL = 3 * 60 * 60 * 1000;
const AVATAR_CACHE_MAX_SIZE = 500;

const avatarCache = new Cache<string, string | null>({
  maxSize: AVATAR_CACHE_MAX_SIZE,
  defaultTTL: AVATAR_CACHE_TTL,
});

const inflight = new Map<string, Promise<string | null>>();

/** Sentinel: a transient failure — return `null` to the caller, don't cache. */
const TRANSIENT = Symbol("transient");
type FetchOutcome = string | null | typeof TRANSIENT;

interface SearchUsersResponse {
  items?: Array<{ avatar_url?: unknown }>;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function fetchAvatarByEmail(email: string, signal?: AbortSignal): Promise<FetchOutcome> {
  const token = GitHubAuth.getToken();
  // The unauthenticated Search limit (10 req/min) is too tight to be useful.
  // Without a token we don't open a socket — and we treat it as transient so
  // a token configured later resolves on the next render.
  if (!token) return TRANSIENT;

  try {
    const url = `https://api.github.com/search/users?q=${encodeURIComponent(email)}+in:email`;
    const response = await rateLimitAwareFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Daintree-Electron",
      },
      // Compose the caller's abort signal with the API timeout so neither is
      // silently dropped — a caller-provided signal must not disable the
      // timeout, and vice versa.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(GITHUB_API_TIMEOUT_MS)])
        : AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    if (!response.ok) {
      // 422 is GitHub's "the query itself can't match" — a genuine, stable
      // miss worth caching. 403/429/5xx are transient and must not be.
      return response.status === 422 ? null : TRANSIENT;
    }

    const body = (await response.json()) as SearchUsersResponse;
    const avatarUrl = body.items?.[0]?.avatar_url;
    return typeof avatarUrl === "string" && avatarUrl.length > 0 ? avatarUrl : null;
  } catch (error) {
    // Rate-limit, network, and abort errors stay inside the provider — the
    // caller only ever sees a resolved URL or `null`, never backoff state.
    if (error instanceof GitHubRateLimitError) return TRANSIENT;
    return TRANSIENT;
  }
}

async function resolveByEmail(email: string, signal?: AbortSignal): Promise<string | null> {
  const key = normalizeEmail(email);
  if (key.length === 0) return null;

  const cached = avatarCache.get(key);
  if (cached !== undefined) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const request = fetchAvatarByEmail(key, signal)
    .then((outcome) => {
      // A genuine outcome means the HTTP call completed — cache it regardless
      // of the initiating caller's signal. The singleflight promise is shared
      // by every concurrent caller, so keying the cache write off the *first*
      // caller's abort would deny a successful result to all the others and
      // leave the cache empty. An aborted in-flight fetch never reaches here:
      // its AbortError is caught and mapped to TRANSIENT (uncached, retryable).
      if (outcome === TRANSIENT) return null;
      avatarCache.set(key, outcome);
      return outcome;
    })
    .finally(() => {
      // Drop the entry so a failed/aborted/transient lookup is retryable.
      inflight.delete(key);
    });

  inflight.set(key, request);
  return request;
}

export const gitHubProfilePictureProvider: ProfilePictureProvider = {
  providerId: BUILTIN_GITHUB_PROVIDER_ID,
  resolveByEmail,
};

/**
 * IPC-facing entry point — the forge avatars capability calls this
 * (`electron/ipc/handlers/forgeData.ts` via `forgeProvider.ts`).
 * Returns `string | null`; `undefined`-while-loading is the renderer hook's
 * abstraction, not part of the provider contract.
 */
export function resolveAuthorAvatar(email: string): Promise<string | null> {
  return resolveByEmail(email);
}

/** Test-only — reset the module-level caches between unit tests. */
export function _resetGitHubProfilePictureCachesForTests(): void {
  avatarCache.clear();
  inflight.clear();
}
