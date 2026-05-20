import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";
import { getServiceConnectivityRegistry } from "../../services/connectivity/index.js";
import type { ServiceConnectivitySnapshot } from "../../../shared/types/ipc.js";
import { defineIpcNamespace, op } from "../define.js";
import { CONNECTIVITY_METHOD_CHANNELS } from "./connectivity.preload.js";

export const connectivityNamespace = defineIpcNamespace({
  name: "connectivity",
  ops: {
    getState: op(
      CONNECTIVITY_METHOD_CHANNELS.getState,
      async (): Promise<ServiceConnectivitySnapshot> => {
        const registry = getServiceConnectivityRegistry();
        return registry.getSnapshot();
      }
    ),
  },
});

export function registerConnectivityHandlers(): () => void {
  const registry = getServiceConnectivityRegistry();
  // Register the IPC namespace first so a duplicate-channel throw leaves no
  // dangling `onChange` listener — registering the broadcast subscription
  // before `register()` would leak it on a failed second registration in
  // dev/hot-reload.
  const namespaceCleanup = connectivityNamespace.register();

  // Push every state change to all renderers. The registry already guards
  // against silent seeding so this only fires on real transitions.
  const broadcastCleanup = registry.onChange((payload) => {
    broadcastToRenderer(CHANNELS.CONNECTIVITY_SERVICE_CHANGED, payload);
  });

  return () => {
    broadcastCleanup();
    namespaceCleanup();
  };
}
