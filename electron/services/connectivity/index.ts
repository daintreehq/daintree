import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { getForgeProviderImpl, onForgeProviderRegistryChanged } from "../forgeProviderRegistry.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../../shared/utils/forgeProviderIds.js";
import type { ForgeTokenHealthState, HealthEventsCapability } from "../../../shared/types/forge.js";
import {
  ServiceConnectivityRegistry,
  type ServiceConnectivityRegistryOptions,
} from "./ServiceConnectivityRegistry.js";
import type { MainProcessToastPayload } from "../../../shared/types/ipc/maps.js";

export { ServiceConnectivityRegistry } from "./ServiceConnectivityRegistry.js";
export type { ServiceConnectivityRegistryOptions } from "./ServiceConnectivityRegistry.js";

let registryInstance: ServiceConnectivityRegistry | null = null;

type McpServerLike = ServiceConnectivityRegistryOptions["mcpServer"];
type McpStatusListener = (running: boolean) => void;

/**
 * Lazy stand-in for `mcpServerService` so this module — on the boot path via
 * `getServiceConnectivityRegistry()` — never imports the ~637KB MCP server
 * stack. `ServiceConnectivityRegistry.start()` subscribes synchronously during
 * boot, before the MCP module can have loaded, so the proxy buffers those
 * subscriptions and forwards them when `wireMcpServerToConnectivityRegistry()`
 * installs the real service. `McpServerService.ts` calls the wire function at
 * module scope, which preserves the documented onStatusChange-before-first-event
 * ordering: every subscription is forwarded before any caller can obtain the
 * service and call `start()` on it.
 */
class LazyMcpServerProxy {
  private real: McpServerLike | null = null;
  private readonly pending = new Map<McpStatusListener, { unsubscribe: (() => void) | null }>();

  get isRunning(): boolean {
    return this.real?.isRunning ?? false;
  }

  onStatusChange(listener: McpStatusListener): () => void {
    if (this.real) return this.real.onStatusChange(listener);
    const entry: { unsubscribe: (() => void) | null } = { unsubscribe: null };
    this.pending.set(listener, entry);
    return () => {
      entry.unsubscribe?.();
      entry.unsubscribe = null;
      this.pending.delete(listener);
    };
  }

  setReal(service: McpServerLike): void {
    if (this.real) return;
    this.real = service;
    for (const [listener, entry] of this.pending) {
      entry.unsubscribe = service.onStatusChange(listener);
    }
  }
}

let mcpServerProxy = new LazyMcpServerProxy();

/**
 * Install the real `mcpServerService` behind the connectivity registry's lazy
 * MCP slot. Idempotent — only the first call wires. Called from
 * `McpServerService.ts` at module scope so every load path (deferred boot
 * task, help-session provision, agent-spawn `ensureReady`, settings IPC) wires
 * exactly once.
 */
export function wireMcpServerToConnectivityRegistry(service: McpServerLike): void {
  mcpServerProxy.setReal(service);
}

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
 * token health and `mcpServerService`, and emits a single "Connection
 * restored" toast on `unreachable → reachable` transitions.
 *
 * In practice MCP is the only source that can reach that edge: GitHub maps
 * `unhealthy` to `unknown`, never `unreachable`. Keep that in mind before
 * assuming this callback is dead.
 */
export function getServiceConnectivityRegistry(): ServiceConnectivityRegistry {
  if (!registryInstance) {
    registryInstance = new ServiceConnectivityRegistry({
      gitHubHealth: createForgeTokenHealthSource(BUILTIN_GITHUB_PROVIDER_ID),
      mcpServer: mcpServerProxy,
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

/**
 * Test-only helper to reset the singleton between cases. Also replaces the
 * lazy MCP proxy — note that `McpServerService.ts` wires its singleton at
 * module scope, so a test that imports that module (directly or transitively)
 * has already wired the OLD proxy; the fresh one stays unwired until the test
 * calls `wireMcpServerToConnectivityRegistry` itself. Use fakes, not the real
 * singleton, in tests that rely on this reset.
 */
export function _resetServiceConnectivityRegistryForTests(): void {
  if (registryInstance) {
    registryInstance.dispose();
    registryInstance = null;
  }
  mcpServerProxy = new LazyMcpServerProxy();
}
