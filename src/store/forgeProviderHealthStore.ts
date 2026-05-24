import { create } from "zustand";
import type { ForgeRateLimitKind } from "@shared/types";

/**
 * Renderer source of truth for forge provider health (rate-limit + token
 * health), keyed by canonical `providerId`. GitHub and any additional forge
 * provider get their own slice — state never bleeds across providers.
 *
 * Plain `Record`, not a `Map`: Zustand 5's reference-equality check does not
 * see `Map.set()` (the Map reference is unchanged), so every mutation spreads
 * a new `providers` object and a new per-provider object. Selectors fall back
 * to {@link DEFAULT_PROVIDER_HEALTH} for an unseen provider — they must never
 * silently return another provider's slice.
 *
 * Module-level singleton: each WebContentsView is its own renderer process
 * with its own store instance, so per-view isolation is structural — no
 * Context or per-view factory is needed.
 */
export interface ForgeProviderHealth {
  rateLimitBlocked: boolean;
  rateLimitKind: ForgeRateLimitKind | null;
  rateLimitResetAt: number | null;
  rateLimitMultiplier: number;
  tokenUnhealthy: boolean;
}

// Frozen: the selector returns this by reference for an unseen provider, so a
// stray mutation would corrupt every future unseen-provider lookup.
export const DEFAULT_PROVIDER_HEALTH: ForgeProviderHealth = Object.freeze({
  rateLimitBlocked: false,
  rateLimitKind: null,
  rateLimitResetAt: null,
  rateLimitMultiplier: 1,
  tokenUnhealthy: false,
});

/** Normalized rate-limit state applied to a provider's slice. */
export interface ForgeRateLimitState {
  blocked: boolean;
  kind: ForgeRateLimitKind | null;
  resetAt?: number | null;
  throttleMultiplier?: number;
}

interface ForgeProviderHealthStore {
  providers: Record<string, ForgeProviderHealth>;
  applyRateLimit: (providerId: string, state: ForgeRateLimitState) => void;
  setTokenUnhealthy: (providerId: string, value: boolean) => void;
}

function mergeProvider(
  store: ForgeProviderHealthStore,
  providerId: string,
  patch: Partial<ForgeProviderHealth>
): Record<string, ForgeProviderHealth> {
  const prev = store.providers[providerId] ?? DEFAULT_PROVIDER_HEALTH;
  return {
    ...store.providers,
    [providerId]: { ...DEFAULT_PROVIDER_HEALTH, ...prev, ...patch },
  };
}

export const useForgeProviderHealthStore = create<ForgeProviderHealthStore>((set) => ({
  providers: {},
  applyRateLimit: (providerId, state) => {
    const multiplier =
      Number.isFinite(state.throttleMultiplier ?? 1) && (state.throttleMultiplier ?? 1) >= 1
        ? (state.throttleMultiplier ?? 1)
        : 1;
    set((s) => ({
      providers: mergeProvider(
        s,
        providerId,
        state.blocked
          ? {
              rateLimitBlocked: true,
              rateLimitKind: state.kind ?? null,
              rateLimitResetAt: state.resetAt ?? null,
              rateLimitMultiplier: multiplier,
            }
          : {
              rateLimitBlocked: false,
              rateLimitKind: null,
              rateLimitResetAt: null,
              rateLimitMultiplier: multiplier,
            }
      ),
    }));
  },
  setTokenUnhealthy: (providerId, value) =>
    set((s) => ({
      providers: mergeProvider(s, providerId, { tokenUnhealthy: value }),
    })),
}));

/**
 * Selector factory for one provider's health, with the default-fallback for a
 * provider that has not pushed any state yet.
 */
export function selectForgeProviderHealth(
  providerId: string
): (s: ForgeProviderHealthStore) => ForgeProviderHealth {
  return (s) => s.providers[providerId] ?? DEFAULT_PROVIDER_HEALTH;
}
