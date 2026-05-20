import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";
import { getServiceConnectivityRegistry } from "../../services/connectivity/index.js";
import type { ServiceConnectivitySnapshot } from "../../../shared/types/ipc.js";
import { defineIpcNamespace, op } from "../define.js";
import { CONNECTIVITY_METHOD_CHANNELS } from "./connectivity.preload.js";

export const connectivityNamespace = defineIpcNamespace({
  name: "connectivity",
  ops: {
    getState: op(CONNECTIVITY_METHOD_CHANNELS.getState, async (): Promise<ServiceConnectivitySnapshot> => {
      const registry = getServiceConnectivityRegistry();
      return registry.getSnapshot();
    }),
  },
});

export function registerConnectivityHandlers(): () => void {
  const registry = getServiceConnectivityRegistry();
  const cleanups: Array<() => void> = [];

  // Push every state change to all renderers. The registry already guards
  // against silent seeding so this only fires on real transitions.
  cleanups.push(
    registry.onChange((payload) => {
      broadcastToRenderer(CHANNELS.CONNECTIVITY_SERVICE_CHANGED, payload);
    })
  );

  // Mount-time state replay. Each `WebContentsView` has an isolated Zustand
  // store, so a window that mounts after the initial probes settled would
  // never see the current state through push events alone.
  cleanups.push(connectivityNamespace.register());

  return () => cleanups.forEach((cleanup) => cleanup());
}
