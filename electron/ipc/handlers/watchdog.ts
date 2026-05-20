import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { defineIpcNamespace, op } from "../define.js";
import { broadcastToRenderer } from "../utils.js";
import { getMainProcessWatchdogClientRef } from "../../window/serviceRefs.js";
import { wireWatchdogDisabledBroadcast } from "../../window/perWindowInit.js";

export function registerWatchdogHandlers(deps: HandlerDependencies): () => void {
  const handleWatchdogRestart = async (): Promise<void> => {
    const client = getMainProcessWatchdogClientRef();
    if (!client) return;
    // Re-wire the disabled broadcast before restarting so a second cap-hit
    // cycle still reaches the renderer. `onDisabled` replaces the listener,
    // so this is safe to call repeatedly.
    wireWatchdogDisabledBroadcast(client, deps.windowRegistry);
    client.restart();
    // Tell every window — including cached project views the per-window
    // loop in `wireWatchdogDisabledBroadcast` would miss — to clear its
    // banner. Without this, dispatching the action from one window leaves
    // sibling windows displaying a stale disabled banner.
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "watchdog:active",
      payload: undefined,
    });
  };

  const namespace = defineIpcNamespace({
    name: "watchdog",
    ops: {
      restart: op(CHANNELS.WATCHDOG_RESTART, handleWatchdogRestart),
    },
  });

  return namespace.register();
}
