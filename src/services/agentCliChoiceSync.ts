import { cliAvailabilityClient } from "@/clients";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { onHostResync } from "@/store/hostResyncSignal";

/**
 * Keeps this view's launch details current when the copy of an agent's CLI that
 * launches changes (#16399), whichever view or window chose it. Launches start
 * the path this view's store holds, so without this a view would go on starting
 * the copy that launched before. A remote view whose link dropped may have missed
 * the change, so it reads again once the link is back.
 */
export function initAgentCliChoiceSync(): () => void {
  if (typeof window === "undefined" || !window.electron?.agentCliCopies?.onChanged) {
    return () => {};
  }
  const sync = () => {
    void useCliAvailabilityStore.getState().syncFromHost();
  };
  const offChange = cliAvailabilityClient.onCopiesChanged(sync);
  const offResync = onHostResync(sync);
  return () => {
    offChange();
    offResync();
  };
}
