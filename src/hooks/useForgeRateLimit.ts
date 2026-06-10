import { useEffect } from "react";
import { forgeClient } from "@/clients/forgeClient";
import { useProjectStore } from "@/store/projectStore";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import {
  useForgeProviderHealthStore,
  type ForgeRateLimitState,
} from "@/store/forgeProviderHealthStore";
import type { RateLimitInfo, RateLimitDetails } from "@shared/types/forge";

/**
 * Subscribes to main-process forge rate-limit pushes and mirrors the current
 * state into the providerId-keyed health store. Consumers (resource-list
 * dropdowns, badge freshness hooks, etc.) read from the store so a single
 * subscription drives every forge-aware view — no per-hook IPC listeners that
 * would leak or desynchronize. Mirrors the `useForgeTokenHealth` wiring
 * pattern.
 */
export function useForgeRateLimit(): void {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const { providerId } = useResolvedForgeProvider(projectId);

  useEffect(() => {
    let cancelled = false;
    const pushApplied = new Set<string>();

    const apply = (id: string, state: ForgeRateLimitState, source: "push" | "replay") => {
      if (cancelled) return;
      if (source === "replay" && pushApplied.has(id)) return;
      if (source === "push") pushApplied.add(id);
      useForgeProviderHealthStore.getState().applyRateLimit(id, state);
    };

    const cleanup = forgeClient.onRateLimitChanged((payload) =>
      apply(payload.providerId, toRateLimitState(payload.state), "push")
    );

    // Replay current state on mount so secondary windows / late mounts see the
    // blocked flag without waiting for the next transition. Skipped while no
    // provider resolves for the active project (e.g. owning plugin disabled) —
    // the push subscription stays live so a re-enable flows through.
    if (providerId && projectPath) {
      void forgeClient
        .getRateLimitDetails(projectPath)
        .then((details) => {
          if (!details) return;
          apply(providerId, inferReplayState(details), "replay");
        })
        .catch(() => {
          // Best-effort replay; pushes still drive transitions.
        });
    }

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [providerId, projectPath]);
}

/**
 * Project the provider-agnostic {@link RateLimitInfo} push onto the store's
 * normalized rate-limit shape. A provider is blocked when its budget is spent
 * (`remaining === 0`) or a secondary/abuse throttle is active.
 */
function toRateLimitState(info: RateLimitInfo): ForgeRateLimitState {
  const blocked = info.remaining === 0 || info.secondaryThrottled === true;
  if (!blocked) return { blocked: false, kind: null, throttleMultiplier: info.throttleMultiplier };
  return {
    blocked: true,
    kind: info.secondaryThrottled ? "secondary" : "primary",
    resetAt: info.resetAt ?? null,
    throttleMultiplier: info.throttleMultiplier,
  };
}

function inferReplayState(details: RateLimitDetails): ForgeRateLimitState {
  const now = Date.now();
  // Check every reported bucket — a single exhausted bucket (e.g. a heavy
  // GraphQL caller spending its quota while REST still has budget) blocks the
  // provider's data surfaces, and the doomed first fetch on mount would show a
  // raw error before the push arrived. Secondary/abuse throttles aren't
  // represented in detail snapshots at all; those still rely on the push.
  const exhausted = details.buckets.find((b) => b.remaining === 0 && b.resetAt > now);
  if (exhausted) {
    return { blocked: true, kind: "primary", resetAt: exhausted.resetAt };
  }
  return { blocked: false, kind: null };
}
