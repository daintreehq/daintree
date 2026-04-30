import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { gitHubTokenHealthService } from "../github/GitHubTokenHealthService.js";
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

/**
 * Returns the process-wide `ServiceConnectivityRegistry` singleton, creating
 * it on first call. The registry wires together `gitHubTokenHealthService`,
 * `mcpServerService`, and `agentConnectivityService`, and emits a single
 * "Connection restored" toast on `unreachable → reachable` transitions.
 */
export function getServiceConnectivityRegistry(): ServiceConnectivityRegistry {
  if (!registryInstance) {
    registryInstance = new ServiceConnectivityRegistry({
      gitHubHealth: gitHubTokenHealthService,
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
