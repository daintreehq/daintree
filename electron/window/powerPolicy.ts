import {
  derivePowerPolicy,
  type PowerObservations,
  type PowerPolicySnapshot,
} from "../../shared/types/powerPolicy.js";

// Leaf module: no Electron imports, so services and tests can read or subscribe
// without dragging in the window layer. `powerMonitor.ts` is the only writer —
// it owns every OS and window event that feeds the observations.

type PowerPolicyListener = (next: PowerPolicySnapshot, previous: PowerPolicySnapshot) => void;

const INITIAL_OBSERVATIONS: PowerObservations = {
  onBattery: false,
  screenLocked: false,
  anyWindowFocused: true,
  anyWindowVisible: true,
};

let observations: PowerObservations = { ...INITIAL_OBSERVATIONS };
let snapshot: PowerPolicySnapshot = derivePowerPolicy(observations);
const listeners = new Set<PowerPolicyListener>();

export function getPowerPolicy(): PowerPolicySnapshot {
  return snapshot;
}

/**
 * Merge new observations and notify subscribers when anything changed. Every
 * observation is compared, not just the level: blur inside `saving` (battery,
 * focused → battery, blurred) keeps the level but flips `canObserve`, and
 * consumers that pause while unobserved must still hear about it.
 */
export function updatePowerObservations(partial: Partial<PowerObservations>): void {
  const next: PowerObservations = { ...observations, ...partial };
  if (
    next.onBattery === observations.onBattery &&
    next.screenLocked === observations.screenLocked &&
    next.anyWindowFocused === observations.anyWindowFocused &&
    next.anyWindowVisible === observations.anyWindowVisible
  ) {
    return;
  }
  observations = next;
  const previous = snapshot;
  snapshot = derivePowerPolicy(next);
  for (const listener of Array.from(listeners)) {
    try {
      listener(snapshot, previous);
    } catch (error) {
      console.error("[PowerPolicy] listener threw:", error);
    }
  }
}

export function subscribePowerPolicy(listener: PowerPolicyListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetPowerPolicyForTesting(): void {
  observations = { ...INITIAL_OBSERVATIONS };
  snapshot = derivePowerPolicy(observations);
  listeners.clear();
}
