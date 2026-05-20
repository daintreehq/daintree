import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { defineIpcNamespace, op } from "../define.js";
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
  };

  const namespace = defineIpcNamespace({
    name: "watchdog",
    ops: {
      restart: op(CHANNELS.WATCHDOG_RESTART, handleWatchdogRestart),
    },
  });

  return namespace.register();
}
