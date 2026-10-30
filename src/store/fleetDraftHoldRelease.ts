import { useFleetArmingStore } from "./fleetArmingStore";
import { useTerminalInputStore } from "./terminalInputStore";

const NO_FLEET: ReadonlySet<string> = new Set();

/**
 * Gives each pane the draft it had before the fleet's was mirrored over it as
 * soon as it leaves the fleet, by any route: disarmed, replaced, cleared,
 * pruned, or left the last armed pane alone (#14949). A pane that isn't
 * mounted gets it in the draft store, where its composer reads it on mount.
 *
 * Registered by `initStoreOrchestrator()` for the same HMR-safe lifecycle as
 * `subscribeFleetArmingPanelPruning`, with a pass at registration for holds
 * left behind while it was torn down.
 */
export function subscribeFleetDraftHoldRelease(): () => void {
  // Mirroring needs a second armed pane: one left alone follows nothing.
  const release = (armedIds: Set<string>) =>
    useTerminalInputStore
      .getState()
      .releaseFleetDraftHolds(armedIds.size >= 2 ? armedIds : NO_FLEET);

  release(useFleetArmingStore.getState().armedIds);
  return useFleetArmingStore.subscribe((state, prev) => {
    if (state.armedIds !== prev.armedIds) release(state.armedIds);
  });
}
