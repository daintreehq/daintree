import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { getForgeProviderImpl, onForgeProviderRegistryChanged } from "../forgeProviderRegistry.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../../shared/utils/forgeProviderIds.js";
import type { ForgeTokenHealthState, HealthEventsCapability } from "../../../shared/types/forge.js";
import { mcpServerService } from "../McpServerService.js";
import { agentConnectivityService } from "./AgentConnectivityService.js";
import { ServiceConnectivityRegistry } from "./ServiceConnectivityRegistry.js";
import type { MainProcessToastPayload } from "../../../shared/types/ipc/maps.js";

export {
  agentConnectivityService,
  AgentConnectivityServiceImpl,
  AGENT_CONNECTIVITY_INTERVAL_MS,
  AGENT_CONNECTIVITY_FOCUS_COOLDOWN_MS,
  AGENT_CONNECTIVITY_FETCH_TIMEOUT_MS,
} from "./AgentConnectivityService.js";
export type {
  AgentConnectivityChange,
  AgentConnectivityProvider,
} from "./AgentConnectivityService.js";

export { ServiceConnectivityRegistry } from "./ServiceConnectivityRegistry.js";
export type { ServiceConnectivityRegistryOptions } from "./ServiceConnectivityRegistry.js";

let registryInstance: ServiceConnectivityRegistry | null = null;

const UNKNOWN_TOKEN_HEALTH: ForgeTokenHealthState = {
  status: "unknown",
  tokenVersion: -1,
  checkedAt: 0,
};

/**
 * Adapt the GitHub forge provider's `healthEvents` capability to the
 * registry's token-health source shape. Tracks plugin enable/disable through
 * forge-registry changes: while no impl is bound (plugin disabled) the state
 * reads `unknown`, and subscriptions re-bind when the impl is replaced.
 */
function createForgeTokenHealthSource(providerId: string): {
  getState(): ForgeTokenHealthState;
  onStateChange(listener: (payload: ForgeTokenHealthState) => void): () => void;
} {
  const health = (): HealthEventsCapability | undefined =>
    getForgeProviderImpl(providerId)?.healthEvents;
  return {
    getState: () => health()?.getTokenHealth() ?? UNKNOWN_TOKEN_HEALTH,
    onStateChange(listener) {
      let bound: HealthEventsCapability | null = null;
      let disposeInner: (() => void) | null = null;
      const sync = (): void => {
        const current = health() ?? null;
        if (current === bound) return;
        disposeInner?.();
        disposeInner = null;
        bound = current;
        if (current) {
          disposeInner = current.onTokenHealthChanged(listener);
        } else {
          // Provider unbound (plugin disabled) — retire any settled state.
          listener(UNKNOWN_TOKEN_HEALTH);
        }
      };
      const disposeRegistry = onForgeProviderRegistryChanged(sync);
      sync();
      return () => {
        disposeRegistry();
        disposeInner?.();
      };
    },
  };
}

/**
 * Returns the process-wide `ServiceConnectivityRegistry` singleton, creating
 * it on first call. The registry wires together the GitHub forge provider's
 * token health, `mcpServerService`, and `agentConnectivityService`, and emits
 * a single "Connection restored" toast on `unreachable → reachable` transitions.
 */
export function getServiceConnectivityRegistry(): ServiceConnectivityRegistry {
  if (!registryInstance) {
    registryInstance = new ServiceConnectivityRegistry({
      gitHubHealth: createForgeTokenHealthSource(BUILTIN_GITHUB_PROVIDER_ID),
      mcpServer: mcpServerService,
      agentConnectivity: agentConnectivityService,
      onRecovery: (_serviceKey, label) => {
        const payload: MainProcessToastPayload = {
          type: "info",
          title: "Connection restored",
          message: `Reconnected to ${label}.`,
        };
        broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, payload);
      },
    });
  }
  return registryInstance;
}

/** Test-only helper to reset the singleton between cases. */
export function _resetServiceConnectivityRegistryForTests(): void {
  if (registryInstance) {
    registryInstance.dispose();
    registryInstance = null;
  }
}
