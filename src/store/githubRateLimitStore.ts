import type { GitHubRateLimitKind, GitHubRateLimitPayload } from "@shared/types";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";
import {
  useForgeProviderHealthStore,
  DEFAULT_PROVIDER_HEALTH,
} from "@/store/forgeProviderHealthStore";

/**
 * GitHub-scoped convenience over the provider-keyed
 * {@link useForgeProviderHealthStore}. The forge store is the single source of
 * truth; this is a thin read/write shim so existing GitHub consumers keep the
 * old `{ blocked, kind, resetAt, apply }` API with no churn. It holds no state
 * of its own — there is nothing to desync.
 */
export interface GitHubRateLimitState {
  blocked: boolean;
  kind: GitHubRateLimitKind | null;
  resetAt: number | null;
  throttleMultiplier: number;
  apply: (payload: GitHubRateLimitPayload) => void;
}

const apply = (payload: GitHubRateLimitPayload): void =>
  useForgeProviderHealthStore.getState().applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, {
    blocked: payload.blocked,
    kind: payload.kind,
    resetAt: payload.resetAt ?? null,
    throttleMultiplier: payload.throttleMultiplier,
  });

function gitHubView(): GitHubRateLimitState {
  const p =
    useForgeProviderHealthStore.getState().providers[BUILTIN_GITHUB_PROVIDER_ID] ??
    DEFAULT_PROVIDER_HEALTH;
  return {
    blocked: p.rateLimitBlocked,
    kind: p.rateLimitKind,
    resetAt: p.rateLimitResetAt,
    throttleMultiplier: p.rateLimitMultiplier,
    apply,
  };
}

export function useGitHubRateLimitStore<T>(selector: (state: GitHubRateLimitState) => T): T {
  return useForgeProviderHealthStore((s) => {
    const p = s.providers[BUILTIN_GITHUB_PROVIDER_ID] ?? DEFAULT_PROVIDER_HEALTH;
    return selector({
      blocked: p.rateLimitBlocked,
      kind: p.rateLimitKind,
      resetAt: p.rateLimitResetAt,
      throttleMultiplier: p.rateLimitMultiplier,
      apply,
    });
  });
}

useGitHubRateLimitStore.getState = gitHubView;

/**
 * Test/imperative compatibility with the previous real Zustand store. Existing
 * suites call `.setState({ blocked, kind, resetAt })` for setup; delegate that
 * to the backing keyed store's `applyRateLimit` for GitHub. Object-partial
 * form only (no functional updater) — that is all callers use.
 */
useGitHubRateLimitStore.setState = (
  partial: Partial<
    Pick<GitHubRateLimitState, "blocked" | "kind" | "resetAt" | "throttleMultiplier">
  >
): void => {
  const cur = gitHubView();
  const next = { ...cur, ...partial };
  useForgeProviderHealthStore.getState().applyRateLimit(BUILTIN_GITHUB_PROVIDER_ID, {
    blocked: next.blocked,
    kind: next.kind,
    resetAt: next.resetAt,
    throttleMultiplier: next.throttleMultiplier,
  });
};
