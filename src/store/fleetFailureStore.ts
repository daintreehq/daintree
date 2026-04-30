import { create } from "zustand";
import { useFleetArmingStore } from "@/store/fleetArmingStore";

/**
 * Records the targets that rejected the most recent fleet broadcast plus
 * the payload that should be replayed by "Retry failed". Lives outside
 * `useFleetArmingStore` so failure clearance and arm/disarm are independent
 * — a user can keep typing into the fleet while a failure pill remains
 * visible until they either retry or acknowledge it.
 *
 * The store is intentionally renderer-only (no persistence). Failures are
 * about a single in-flight broadcast; carrying them across reloads would
 * surface stale state for an action the user already moved past.
 *
 * `confirmPendingPaste` in FleetArmingRibbon is the active caller. Fleet
 * input is routed through hybrid-input broadcast or direct xterm raw-input
 * broadcast. Both paths re-resolve the live fleet before writing.
 */
export interface FleetFailureSnapshot {
  /** Per-target ids that rejected the broadcast. */
  failedIds: Set<string>;
  /** The literal payload that should be re-fired on retry. */
  payload: string | null;
  /** Wall clock of the most recent failure record (ms). */
  recordedAt: number | null;
}

interface FleetFailureState extends FleetFailureSnapshot {
  recordFailure: (payload: string, failedIds: Iterable<string>) => void;
  /** Drop a single pane from the failure set (e.g. when retry succeeds). */
  dismissId: (id: string) => void;
  /** Clear everything (user acknowledged, fleet cleared, etc.). */
  clear: () => void;
}

const EMPTY_SET: Set<string> = new Set();

export const useFleetFailureStore = create<FleetFailureState>((set) => ({
  failedIds: EMPTY_SET,
  payload: null,
  recordedAt: null,
  recordFailure: (payload, failedIds) => {
    const ids = new Set(failedIds);
    if (ids.size === 0) {
      set({ failedIds: EMPTY_SET, payload: null, recordedAt: null });
      return;
    }
    set({ failedIds: ids, payload, recordedAt: Date.now() });
  },
  dismissId: (id) =>
    set((s) => {
      if (!s.failedIds.has(id)) return {};
      const next = new Set(s.failedIds);
      next.delete(id);
      if (next.size === 0) {
        return { failedIds: EMPTY_SET, payload: null, recordedAt: null };
      }
      return { failedIds: next };
    }),
  clear: () => set({ failedIds: EMPTY_SET, payload: null, recordedAt: null }),
}));

/**
 * Auto-clear the failure set when the underlying fleet is cleared. A
 * persistent failure dot on a pane the user just disarmed would be confusing
 * — the action context is gone. We only watch for fleet *drain* (size → 0)
 * to avoid wiping failures when the user is just toggling individual panes.
 */
const FLEET_FAILURE_SUBSCRIPTION_KEY = "__daintreeFleetFailureSubscription";

interface FleetFailureSubscriptionState {
  registered: boolean;
}

function getSubscriptionState(): FleetFailureSubscriptionState {
  const target = globalThis as typeof globalThis & {
    [FLEET_FAILURE_SUBSCRIPTION_KEY]?: FleetFailureSubscriptionState;
  };
  const existing = target[FLEET_FAILURE_SUBSCRIPTION_KEY];
  if (existing) return existing;
  const created: FleetFailureSubscriptionState = { registered: false };
  target[FLEET_FAILURE_SUBSCRIPTION_KEY] = created;
  return created;
}

if (typeof useFleetArmingStore.subscribe === "function") {
  const subState = getSubscriptionState();
  if (!subState.registered) {
    subState.registered = true;
    let prevArmed = useFleetArmingStore.getState().armedIds;
    useFleetArmingStore.subscribe((state) => {
      const nextArmed = state.armedIds;
      if (prevArmed === nextArmed) return;

      // Whole fleet drained — clear everything in one shot to avoid the
      // per-id loop below thrashing the store on every removed pane.
      if (nextArmed.size === 0 && prevArmed.size > 0) {
        useFleetFailureStore.getState().clear();
        prevArmed = nextArmed;
        return;
      }

      // Per-pane removal — drop the failure record for any pane that's
      // no longer armed. Disarming a pane (manual or via auto-prune of
      // trashed/exited terminals) means the user has moved on; a stale
      // red dot would just create cleanup work.
      const failed = useFleetFailureStore.getState().failedIds;
      if (failed.size > 0) {
        for (const id of failed) {
          if (!nextArmed.has(id)) {
            useFleetFailureStore.getState().dismissId(id);
          }
        }
      }
      prevArmed = nextArmed;
    });
  }
}
