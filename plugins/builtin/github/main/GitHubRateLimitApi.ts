import { GitHubAuth, GITHUB_API_TIMEOUT_MS, rateLimitAwareFetch } from "./GitHubAuth.js";
import { PRIMARY_RESET_BUFFER_MS } from "./GitHubRateLimitService.js";
import type { GitHubRateLimitDetails } from "../../../../electron/types/index.js";

export async function fetchRateLimitDetails(): Promise<GitHubRateLimitDetails | null> {
  const token = GitHubAuth.getToken();
  if (!token) return null;

  try {
    const response = await rateLimitAwareFetch("https://api.github.com/rate_limit", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      resources?: Record<
        string,
        { limit: number; used: number; remaining: number; reset: number } | undefined
      >;
    };
    const resources = body.resources;
    if (!resources?.core || !resources.graphql || !resources.search) return null;

    const isValidBucket = (
      b: unknown
    ): b is { limit: number; used: number; remaining: number; reset: number } => {
      if (!b || typeof b !== "object") return false;
      const r = b as Record<string, unknown>;
      return [r.limit, r.used, r.remaining, r.reset].every(
        (v) => typeof v === "number" && Number.isFinite(v)
      );
    };
    if (
      !isValidBucket(resources.core) ||
      !isValidBucket(resources.graphql) ||
      !isValidBucket(resources.search)
    )
      return null;

    const toBucket = (b: { limit: number; used: number; remaining: number; reset: number }) => ({
      limit: b.limit,
      used: b.used,
      remaining: b.remaining,
      resetAt: b.reset * 1000 + PRIMARY_RESET_BUFFER_MS,
    });

    return {
      core: toBucket(resources.core),
      graphql: toBucket(resources.graphql),
      search: toBucket(resources.search),
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  }
}
