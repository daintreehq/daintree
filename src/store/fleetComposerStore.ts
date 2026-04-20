import { create } from "zustand";
import { useFleetArmingStore } from "./fleetArmingStore";

interface FleetComposerState {
  draft: string;
  /** When true, the FleetComposer should open the dry-run dialog on next render */
  dryRunRequested: boolean;
  /** Terminal IDs from the most recent broadcast that failed (for retry-failed) */
  lastFailedIds: string[];
  /** The prompt text from the most recent broadcast (for retry-failed) */
  lastBroadcastPrompt: string;
  /** When true, pressing Enter opens dry-run preview instead of sending directly */
  alwaysPreview: boolean;
  /** Broadcast target count that triggers quorum confirmation */
  quorumThreshold: number;
  setDraft: (draft: string) => void;
  clearDraft: () => void;
  requestDryRun: () => void;
  clearDryRunRequest: () => void;
  setLastFailed: (ids: string[], prompt: string) => void;
  clearLastFailed: () => void;
}

export const useFleetComposerStore = create<FleetComposerState>()((set) => ({
  draft: "",
  dryRunRequested: false,
  lastFailedIds: [],
  lastBroadcastPrompt: "",
  alwaysPreview: false,
  quorumThreshold: 5,
  setDraft: (draft) => set({ draft }),
  clearDraft: () => set({ draft: "" }),
  requestDryRun: () => set({ dryRunRequested: true }),
  clearDryRunRequest: () => set({ dryRunRequested: false }),
  setLastFailed: (ids, prompt) => set({ lastFailedIds: ids, lastBroadcastPrompt: prompt }),
  clearLastFailed: () => set({ lastFailedIds: [], lastBroadcastPrompt: "" }),
}));

/**
 * Clear the composer draft whenever the fleet is fully disarmed. The
 * FleetComposer component is unmounted by the ribbon when armedCount → 0,
 * so this cleanup cannot live inside the component — a typed draft would
 * otherwise survive across arm/disarm cycles as a stale singleton.
 *
 * HMR/test re-imports stack subscribers on every module reload. We store
 * registration state on globalThis so subsequent instances reuse the
 * existing subscription but drive the current store — mirroring the
 * pattern in fleetArmingStore.ts / projectStore.ts.
 */
interface FleetComposerSubscriptionState {
  registered: boolean;
  lastCount: number;
}

const FLEET_COMPOSER_SUBSCRIPTION_KEY = "__daintreeFleetComposerSubscription";

function getFleetComposerSubscriptionState(): FleetComposerSubscriptionState {
  const target = globalThis as typeof globalThis & {
    [FLEET_COMPOSER_SUBSCRIPTION_KEY]?: FleetComposerSubscriptionState;
  };
  const existing = target[FLEET_COMPOSER_SUBSCRIPTION_KEY];
  if (existing) return existing;
  const created: FleetComposerSubscriptionState = {
    registered: false,
    lastCount: useFleetArmingStore.getState().armedIds.size,
  };
  target[FLEET_COMPOSER_SUBSCRIPTION_KEY] = created;
  return created;
}

if (typeof useFleetArmingStore.subscribe === "function") {
  const subState = getFleetComposerSubscriptionState();
  if (!subState.registered) {
    subState.registered = true;
    useFleetArmingStore.subscribe((state) => {
      const nextCount = state.armedIds.size;
      const prevCount = subState.lastCount;
      subState.lastCount = nextCount;
      if (prevCount > 0 && nextCount === 0) {
        useFleetComposerStore.getState().clearDraft();
      }
    });
  }
}
