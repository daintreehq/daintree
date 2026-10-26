import type { AgentToolbarPinsSnapshot } from "@shared/types";
import { agentToolbarPinsClient } from "@/clients/agentToolbarPinsClient";
import { getSafeBootPromise } from "@/lib/bootPromise";
import { useAgentToolbarPinsStore } from "@/store/agentToolbarPinsStore";
import { logWarn } from "@/utils/logger";

/**
 * Keeps this view's copy of this machine's toolbar agent pins current (#14702):
 * seeded from the boot payload (the Shell's half of a remote window's hydrate),
 * then updated by every change pushed from main, whichever view made it. The
 * store's revision check drops a seed that a push has already overtaken.
 */
export function initAgentToolbarPinsSync(): () => void {
  if (typeof window === "undefined" || !window.electron?.agentToolbarPins) return () => {};

  let disposed = false;
  const apply = (snapshot: AgentToolbarPinsSnapshot | undefined) => {
    if (disposed || !snapshot) return;
    useAgentToolbarPinsStore.getState().applySnapshot(snapshot);
  };

  const unsubscribe = agentToolbarPinsClient.onChanged(apply);

  void (async () => {
    const boot = await getSafeBootPromise();
    const fromBoot = boot.ok ? boot.result.agentToolbarPins : undefined;
    if (fromBoot) {
      apply(fromBoot);
      return;
    }
    if (disposed) return;
    try {
      apply(await agentToolbarPinsClient.get());
    } catch (error) {
      logWarn("[agentToolbarPins] couldn't read this machine's toolbar pins", {
        error: String(error),
      });
    }
  })();

  return () => {
    disposed = true;
    unsubscribe();
  };
}
