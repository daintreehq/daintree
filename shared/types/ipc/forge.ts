import type { RateLimitInfo } from "../forge.js";

/**
 * Provider-agnostic rate-limit kind. `primary` is quota exhaustion (the
 * provider's request budget is spent until `resetAt`); `secondary` is an
 * abuse / burst throttle. The vocabulary is intentionally generic — it is
 * not GitHub-specific even though GitHub is currently the only built-in
 * provider that reports it.
 */
export type ForgeRateLimitKind = "primary" | "secondary";

/**
 * Push payload for `forge:rate-limit-changed`. Carries the canonical
 * `providerId` so the renderer can key state per provider — GitHub and any
 * additional forge provider flow through the same channel and never
 * cross-contaminate. `state` is the provider-agnostic {@link RateLimitInfo}
 * the workspace-host observed; the renderer normalizes it per provider.
 */
export interface ForgeRateLimitChangedPayload {
  providerId: string;
  state: RateLimitInfo;
}

/**
 * Push payload for `forge:token-health-changed`. Forward-compat scaffolding:
 * the channel, store keying, and router broadcast are wired so a provider
 * implementation that gains token-health probing can emit this with no
 * further plumbing. No workspace-host emitter produces it yet — GitHub token
 * health still flows over the legacy `github:token-health-changed` channel.
 */
export interface ForgeTokenHealthChangedPayload {
  providerId: string;
  isUnhealthy: boolean;
}
