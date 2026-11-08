import { cliAvailabilityClient } from "@/clients";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";

/**
 * Keeps this view's launch details current when the copy of an agent's CLI that
 * launches changes (#16399), whichever view or window chose it. Launches start
 * the path this view's store holds, so without this a view would go on starting
 * the copy that launched before.
 */
export function initAgentCliChoiceSync(): () => void {
  if (typeof window === "undefined" || !window.electron?.agentCliCopies?.onChanged) {
    return () => {};
  }
  return cliAvailabilityClient.onCopiesChanged(() => {
    void useCliAvailabilityStore.getState().syncFromHost();
  });
}
