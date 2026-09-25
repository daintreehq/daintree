import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToProjectRenderers, broadcastToRenderer } from "../../ipc/utils.js";
import { OperationRegistry } from "./OperationRegistry.js";

export {
  OperationRegistry,
  normalizeOperationId,
  OPERATION_RETENTION_MS,
  OPERATION_MAX_SETTLED,
  type OperationHandle,
  type OperationStartInput,
  type OperationRunOptions,
} from "./OperationRegistry.js";

let registry: OperationRegistry | null = null;

export function getOperationRegistry(): OperationRegistry {
  registry ??= new OperationRegistry({
    emit: (projectId, event) => {
      if (projectId === null) {
        broadcastToRenderer(CHANNELS.OPERATIONS_EVENT, event);
      } else {
        broadcastToProjectRenderers(projectId, CHANNELS.OPERATIONS_EVENT, event);
      }
    },
  });
  return registry;
}

export function _resetOperationRegistryForTest(next: OperationRegistry | null = null): void {
  registry = next;
}
