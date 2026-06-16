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
  // Tracks which providers have an active "token expired" inbox row this
  // session, so the recovery row fires only after a warning was shown. Resets
  // on remount: a token that expired in a prior session and is already healthy
  // on a fresh mount won't emit a recovery row, so its stale warning row can
  // persist in the inbox until the next expiry/recovery cycle. Pre-existing
  // latch behavior (the removed `useForgeTokenExpiryNotification` shared it);
  // acceptable for an inbox-only row.
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
        // Inbox-only signal (priority "low" → no toast) for an expired token.
        // The persistent `<ForgeTokenBanner />` and toolbar indicator are the
        // primary surfaces; this row gives keyboard/screen-reader users a
        // durable record without the intrusive toast that used to fire here.
        // Shares `supersedeKey` with the recovery row below so the recovery
        // archives it — one active row per token-expiry event.
        // No `correlationId`: it would only thread this row so that a second
        // expiry cycle re-promotes the backstop into an unwanted toast via the
        // un-snooze re-toast path. The supersede dedup runs on `supersedeKey`
        // alone.
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

      if (!isUnhealthy && inboxedRef.current.has(id)) {
        inboxedRef.current.delete(id);
        // Recovery acknowledgement — inbox-only (priority "low" → no toast),
        // emitted only when a warning row was previously written for this
        // provider. Shares `supersedeKey` so it archives the active warning
        // row, leaving one resolved row per expiry/recovery cycle so
        // keyboard/screen-reader users get an explicit "working again" signal.
        void resolveProviderMeta(id).then(({ name }) => {
          if (cancelled) return;
          const display = name ?? id;
          notify({
            type: "success",
            priority: "low",
            title: `${display} token validated`,
            message: `Your ${display} token is working again.`,
            supersedeKey: forgeTokenSupersedeKey(id),
            countable: false,
            context: { eventKind: "connectivity" },
          });
        });
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
