import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";
import { initializeOsDndService } from "../../services/OsDndService.js";
import type { HandlerDependencies } from "../types.js";
import { defineIpcNamespace, op } from "../define.js";
import { OS_DND_METHOD_CHANNELS } from "./osDnd.preload.js";

export function registerOsDndHandlers(_deps: HandlerDependencies): () => void {
  // Initialize eagerly during handler registration so the first renderer
  // hydrate IPC call always lands on a probed service. The matching deferred
  // task (electron/window/globalServicesInit.ts) is idempotent and remains in
  // place for symmetry with sibling services.
  const osDndService = initializeOsDndService();

  const namespace = defineIpcNamespace({
    name: "osDnd",
    ops: {
      getState: op(OS_DND_METHOD_CHANNELS.getState, async (): Promise<boolean | undefined> =>
        osDndService.getState()
      ),
    },
  });

  const cleanups: Array<() => void> = [];
  cleanups.push(namespace.register());

  cleanups.push(
    osDndService.onStateChanged((osDndActive) => {
      broadcastToRenderer(CHANNELS.OS_DND_STATE_CHANGED, { osDndActive });
    })
  );

  return () => cleanups.forEach((cleanup) => cleanup());
}
