import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import {
  getForgeProviderImplEntries,
  onForgeProviderRegistryChanged,
} from "./forgeProviderRegistry.js";
import type { ForgeProviderImpl } from "../../shared/types/forge.js";
import type {
  ForgeRateLimitChangedPayload,
  ForgeTokenHealthChangedPayload,
} from "../../shared/types/ipc/forge.js";

/**
 * Host-side relay between each registered provider's `healthEvents`
 * capability and the providerId-keyed `forge:*` push channels. The host
 * subscribes once per bound impl (diffed against the registry on every
 * change) and disposes subscriptions when an impl is replaced or
 * unregistered, so plugin reloads can't leak listeners or double-emit.
 */

interface RelayEntry {
  impl: ForgeProviderImpl;
  disposers: Array<() => void>;
}

let subscriptions: Map<string, RelayEntry> | null = null;
let unsubscribeRegistry: (() => void) | null = null;

// Relay the fetch-throttle multiplier into every workspace host so worktree
// monitor polling backs off as the provider's rate-limit budget depletes.
// The hosts don't observe provider rate limits themselves (#8870) — main
// pushes the state in.
async function relayFetchThrottleToWorkspaceHosts(multiplier: number): Promise<void> {
  try {
    const { getWorkspaceClient } = await import("./WorkspaceClient.js");
    getWorkspaceClient().relayFetchThrottle(multiplier);
  } catch {
    // WorkspaceClient may not be initialized yet — hosts created later are
    // seeded from the pool cache, and this relay fires again on every change.
  }
}

function disposeEntry(entry: RelayEntry): void {
  for (const dispose of entry.disposers) {
    try {
      dispose();
    } catch {
      // A throwing disposer must not block the rest of the teardown.
    }
  }
}

function subscribeProvider(providerId: string, impl: ForgeProviderImpl): RelayEntry | null {
  const health = impl.healthEvents;
  if (!health) return null;
  const disposers: Array<() => void> = [];

  disposers.push(
    health.onTokenHealthChanged((state) => {
      const payload: ForgeTokenHealthChangedPayload = {
        providerId,
        isUnhealthy: state.status === "unhealthy",
        state,
      };
      broadcastToRenderer(CHANNELS.FORGE_TOKEN_HEALTH_CHANGED, payload);
    })
  );

  if (health.onRateLimitChanged) {
    disposers.push(
      health.onRateLimitChanged((info) => {
        const payload: ForgeRateLimitChangedPayload = { providerId, state: info };
        broadcastToRenderer(CHANNELS.FORGE_RATE_LIMIT_CHANGED, payload);
        // Pace workspace-host background fetch cadence against the observed
        // budget — read live from the callback arg, never a cached payload
        // that could predate a token rotation.
        void relayFetchThrottleToWorkspaceHosts(info.throttleMultiplier ?? 1);
      })
    );
  }

  return { impl, disposers };
}

function syncSubscriptions(): void {
  if (!subscriptions) return;
  const current = new Map(getForgeProviderImplEntries());

  // Drop subscriptions for impls that disappeared or were re-bound — a
  // re-registered key carries a new impl object, so identity diffing
  // re-subscribes against the fresh capability.
  for (const [providerId, entry] of [...subscriptions]) {
    if (current.get(providerId) !== entry.impl) {
      disposeEntry(entry);
      subscriptions.delete(providerId);
    }
  }

  for (const [providerId, impl] of current) {
    if (subscriptions.has(providerId)) continue;
    const entry = subscribeProvider(providerId, impl);
    if (entry) subscriptions.set(providerId, entry);
  }
}

export function initForgeHealthRelay(): void {
  if (subscriptions) return;
  subscriptions = new Map();
  unsubscribeRegistry = onForgeProviderRegistryChanged(syncSubscriptions);
  syncSubscriptions();
}

/** Tear down all subscriptions and the registry listener (test isolation). */
export function disposeForgeHealthRelay(): void {
  if (!subscriptions) return;
  unsubscribeRegistry?.();
  unsubscribeRegistry = null;
  for (const entry of subscriptions.values()) {
    disposeEntry(entry);
  }
  subscriptions = null;
}
