import type { GitHubRateLimitPayload } from "../types/ipc/github.js";
import type { RateLimitInfo } from "../types/forge.js";

// Project a GitHub rate-limit payload onto the provider-agnostic RateLimitInfo
// shape. Canonical implementation — main's renderer broadcast and any other
// emit site must use this projection so the rule can't drift between copies.
// `throttleMultiplier` passes through as-is: `undefined` means "not yet
// observed", and consumers that need a usable cadence apply `?? 1` themselves
// (the workspace-host relay, `getRateLimitImpl`, renderer projections).
export function toRateLimitInfo(payload: GitHubRateLimitPayload): RateLimitInfo {
  if (!payload.blocked) {
    // Forward the observed GraphQL budget (if any) so the toolbar can show a
    // remaining-quota indicator even while requests still flow.
    return {
      limit: payload.limit ?? null,
      remaining: payload.remaining ?? null,
      resetAt: null,
      throttleMultiplier: payload.throttleMultiplier,
    };
  }
  // When blocked, force `remaining: 0` — the renderer's GitHub-flavored
  // projection treats `remaining === 0` as the "blocked" signal, so the exact
  // (1–50) hard-stop-band count must not leak through as a non-zero value.
  return {
    limit: payload.limit ?? null,
    remaining: 0,
    resetAt: payload.resetAt ?? null,
    ...(payload.kind === "secondary" ? { secondaryThrottled: true } : {}),
    throttleMultiplier: payload.throttleMultiplier,
  };
}
