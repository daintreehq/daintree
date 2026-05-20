import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { broadcastToRenderer } from "../utils.js";
import { getServiceConnectivityRegistry } from "../../services/connectivity/index.js";

async function handleGetState() {
  return getServiceConnectivityRegistry().getSnapshot();
}

export const connectivityNamespace = defineIpcNamespace({
  name: "connectivity",
  ops: {
    getState: op(CHANNELS.CONNECTIVITY_GET_STATE, handleGetState),
  },
});

export function registerConnectivityHandlers(): () => void {
  const handlers: Array<() => void> = [];
  const registry = getServiceConnectivityRegistry();

  // Push every state change to all renderers. The registry already guards
  // against silent seeding so this only fires on real transitions.
  handlers.push(
    registry.onChange((payload) => {
      broadcastToRenderer(CHANNELS.CONNECTIVITY_SERVICE_CHANGED, payload);
    })
  );

  // Mount-time state replay. Each `WebContentsView` has an isolated Zustand
  // store, so a window that mounts after the initial probes settled would
  // never see the current state through push events alone.
  handlers.push(connectivityNamespace.register());

  return () => handlers.forEach((cleanup) => cleanup());
}
