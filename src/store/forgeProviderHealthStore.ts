import { create } from "zustand";
import type { ForgeRateLimitKind } from "@shared/types";
import type { ForgeTokenHealthState } from "@shared/types/forge";
import { usePluginRuntimeStore } from "./pluginRuntimeStore";

/**
 * Renderer source of truth for forge provider health (rate-limit + token
 * health), keyed by canonical `providerId`. Every registered forge provider
 * gets its own slice — state never bleeds across providers.
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
  // User dismissed the token-health banner for the current unhealthy episode.
  // Reset on every health transition so a fresh expiry re-surfaces the banner.
  tokenBannerDismissed: boolean;
  // Last provider-reported token-health snapshot (carries `reauthUrl` for
  // banner surfaces). Cleared when the token recovers without a fresh state.
  tokenHealth: ForgeTokenHealthState | null;
  // Registration metadata resolved from the forge registry at push time so
  // store-driven surfaces (banner, priority slot) can render a display name
  // and gate on the owning plugin's enable state without an IPC round-trip.
  providerName: string | null;
  pluginId: string | null;
}

// Frozen: the selector returns this by reference for an unseen provider, so a
// stray mutation would corrupt every future unseen-provider lookup.
export const DEFAULT_PROVIDER_HEALTH: ForgeProviderHealth = Object.freeze({
  rateLimitBlocked: false,
  rateLimitKind: null,
  rateLimitResetAt: null,
  rateLimitMultiplier: 1,
  tokenUnhealthy: false,
  tokenBannerDismissed: false,
  tokenHealth: null,
  providerName: null,
  pluginId: null,
});

/** Normalized rate-limit state applied to a provider's slice. */
export interface ForgeRateLimitState {
  blocked: boolean;
  kind: ForgeRateLimitKind | null;
  resetAt?: number | null;
  throttleMultiplier?: number;
}

/** Registration metadata attached to a provider's slice. */
export interface ForgeProviderMeta {
  providerName: string | null;
  pluginId: string | null;
}

interface ForgeProviderHealthStore {
  providers: Record<string, ForgeProviderHealth>;
  applyRateLimit: (providerId: string, state: ForgeRateLimitState) => void;
  setTokenUnhealthy: (providerId: string, value: boolean, state?: ForgeTokenHealthState) => void;
  setProviderMeta: (providerId: string, meta: ForgeProviderMeta) => void;
  dismissTokenBanner: (providerId: string) => void;
  removeProvider: (providerId: string) => void;
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
  setTokenUnhealthy: (providerId, value, state) =>
    set((s) => {
      const prev = s.providers[providerId] ?? DEFAULT_PROVIDER_HEALTH;
      // Clear the dismissed flag on a real transition only. Repeated identical
      // "still unhealthy" pushes must not un-dismiss a banner the user closed,
      // but a fresh expiry (healthy → unhealthy) or recovery resets it.
      const tokenBannerDismissed = value && prev.tokenUnhealthy ? prev.tokenBannerDismissed : false;
      // Keep the last snapshot while unhealthy (a bare boolean push must not
      // drop a previously observed reauthUrl); clear it on recovery unless the
      // recovery push carries its own fresh state.
      const tokenHealth = state ?? (value ? prev.tokenHealth : null);
      return {
        providers: mergeProvider(s, providerId, {
          tokenUnhealthy: value,
          tokenBannerDismissed,
          tokenHealth,
        }),
      };
    }),
  setProviderMeta: (providerId, meta) =>
    set((s) => ({
      providers: mergeProvider(s, providerId, {
        providerName: meta.providerName,
        pluginId: meta.pluginId,
      }),
    })),
  dismissTokenBanner: (providerId) =>
    set((s) => ({
      providers: mergeProvider(s, providerId, { tokenBannerDismissed: true }),
    })),
  // Drop a provider's slice entirely. Without this the `providers` Record only
  // ever grew (every `mergeProvider` adds, nothing removes), so a plugin that
  // registered a forge provider leaked its health slice for the renderer's
  // lifetime after the plugin was disabled (#10842).
  removeProvider: (providerId) =>
    set((s) => {
      if (!(providerId in s.providers)) return s;
      const { [providerId]: _removed, ...rest } = s.providers;
      return { providers: rest };
    }),
}));

// Evict health slices for providers whose owning plugin has been disabled.
// `pluginRuntimeStore` is the renderer's ground truth for plugin enable state
// (#9322 — renderer cleanup is a separate path from the main-process unload
// cascade). Plain `subscribe` (pluginRuntimeStore has no `subscribeWithSelector`
// middleware) fires on any state change, so guard on the `disabledPluginIds`
// reference and bail when no providers are tracked.
//
// Known gap (out of scope for #10842, which targets unbounded growth): a push
// already in flight when the plugin is disabled could re-add a single slice
// after this pass, and it won't re-fire (the set reference is unchanged). That
// is one stale slice for a finite, reused provider id — bounded, not a leak —
// and the main process gates plugin-backed IPC, so the race is narrow.
usePluginRuntimeStore.subscribe((state, prev) => {
  if (state.disabledPluginIds === prev.disabledPluginIds) return;
  const { providers, removeProvider } = useForgeProviderHealthStore.getState();
  for (const [providerId, health] of Object.entries(providers)) {
    if (health.pluginId && state.disabledPluginIds.has(health.pluginId)) {
      removeProvider(providerId);
    }
  }
});

/**
 * Selector factory for one provider's health, with the default-fallback for a
 * provider that has not pushed any state yet.
 */
export function selectForgeProviderHealth(
  providerId: string
): (s: ForgeProviderHealthStore) => ForgeProviderHealth {
  return (s) => s.providers[providerId] ?? DEFAULT_PROVIDER_HEALTH;
}
