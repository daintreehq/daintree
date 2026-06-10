import { useEffect, useRef } from "react";
import { forgeClient } from "@/clients/forgeClient";
import { notify } from "@/lib/notify";
import { useProjectStore } from "@/store/projectStore";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import type { ForgeTokenHealthState } from "@shared/types/forge";

export const forgeTokenSupersedeKey = (providerId: string): string => `forge-token:${providerId}`;

// Registration metadata (display name, owning plugin) per canonical provider
// id, resolved once and shared across windows of this renderer. Failed lookups
// are not cached so a later push can retry.
const metaPromises = new Map<string, Promise<{ name: string | null; pluginId: string | null }>>();

function resolveProviderMeta(
  providerId: string
): Promise<{ name: string | null; pluginId: string | null }> {
  const cached = metaPromises.get(providerId);
  if (cached) return cached;
  const promise = window.electron.forge
    .getProviders()
    .then((entries) => {
      const entry = entries.find(
        (e) => makeForgeProviderId(e.pluginId, e.contribution.id) === providerId
      );
      if (!entry) {
        metaPromises.delete(providerId);
        return { name: null, pluginId: null };
      }
      return { name: entry.contribution.name, pluginId: entry.pluginId };
    })
    .catch(() => {
      metaPromises.delete(providerId);
      return { name: null, pluginId: null };
    });
  metaPromises.set(providerId, promise);
  return promise;
}

/** Test-only: reset the module-level provider-meta cache between cases. */
export function _resetForgeProviderMetaCacheForTest(): void {
  metaPromises.clear();
}

/**
 * Subscribes to main-process forge token-health pushes (providerId-keyed) and
 * writes the unhealthy flag plus the full provider-reported snapshot to the
 * provider-keyed health store. The renderer surfaces the state via
 * `<ForgeTokenBanner />`, which is a persistent inline banner — toasts were a
 * poor fit for state that persists until the user reconnects.
 */
export function useForgeTokenHealth(): void {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const { providerId } = useResolvedForgeProvider(projectId);
  const inboxedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const pushApplied = new Set<string>();

    const apply = (
      id: string,
      isUnhealthy: boolean,
      state: ForgeTokenHealthState | undefined,
      source: "push" | "replay"
    ) => {
      if (cancelled) return;
      // If a live push already updated state, ignore a stale initial-replay
      // response (the IPC race is rare but real — see review notes).
      if (source === "replay" && pushApplied.has(id)) return;
      if (source === "push") pushApplied.add(id);

      const store = useForgeProviderHealthStore.getState();
      const wasUnhealthy = store.providers[id]?.tokenUnhealthy ?? false;
      store.setTokenUnhealthy(id, isUnhealthy, state);

      void resolveProviderMeta(id).then((meta) => {
        useForgeProviderHealthStore
          .getState()
          .setProviderMeta(id, { providerName: meta.name, pluginId: meta.pluginId });
      });

      if (isUnhealthy && !wasUnhealthy && !inboxedRef.current.has(id)) {
        inboxedRef.current.add(id);
        // Inbox-only backstop (priority "low" → no toast) for the no-project
        // case where the toolbar's `useForgeTokenExpiryNotification` isn't
        // mounted. Shares `supersedeKey` with that hook so whichever fires
        // second archives the first — one active row per token-expiry event.
        // No `correlationId`: it would only thread this row so that a second
        // expiry cycle (after the toolbar archived the first row) re-promotes
        // the backstop into an unwanted toast via the un-snooze re-toast path.
        // The supersede dedup runs on `supersedeKey` alone.
        void resolveProviderMeta(id).then(({ name }) => {
          if (cancelled) return;
          const display = name ?? id;
          notify({
            type: "warning",
            priority: "low",
            title: `${display} token expired`,
            message: `${display} token expired — reconnect to restore ${display} features.`,
            supersedeKey: forgeTokenSupersedeKey(id),
            countable: false,
            context: { eventKind: "connectivity" },
          });
        });
      }

      if (!isUnhealthy) {
        inboxedRef.current.delete(id);
      }
    };

    const cleanup = forgeClient.onTokenHealthChanged((payload) =>
      apply(payload.providerId, payload.isUnhealthy, payload.state, "push")
    );

    // Replay current state on mount so secondary windows / late mounts see the
    // unhealthy flag without waiting for a transition. Keyed to the active
    // project's resolved provider — pushes cover every other provider.
    if (providerId) {
      void forgeClient
        .getTokenHealth(providerId)
        .then((state) => {
          if (!state) return;
          apply(providerId, state.status === "unhealthy", state, "replay");
        })
        .catch(() => {
          // Initial-state fetch is best-effort; transitions still work.
        });
    }

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [providerId]);
}
