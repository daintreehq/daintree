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
  /**
   * How many targets of the SAME broadcast failed permanently and were
   * auto-disarmed. Snapshotted here (not read live from the run store) so the
   * banner never pairs this broadcast's retryable failures with another run's
   * disarm count — the failure surface stays internally consistent even after
   * the supervised run is superseded or dismissed (#10930).
   */
  disarmedCount: number;
}

interface FleetFailureState extends FleetFailureSnapshot {
  recordFailure: (
    payload: string | null,
    failedIds: Iterable<string>,
    disarmedCount?: number
  ) => void;
  /** Drop a single pane from the failure set (e.g. when retry succeeds). */
  dismissId: (id: string) => void;
  /** Clear everything (user acknowledged, fleet cleared, etc.). */
  clear: () => void;
}

const EMPTY_SET: Set<string> = new Set();

export const useFleetFailureStore = create<FleetFailureState>((set) => ({
  failedIds: EMPTY_SET,
  payload: null,
  disarmedCount: 0,
  recordFailure: (payload, failedIds, disarmedCount = 0) => {
    const ids = new Set(failedIds);
    if (ids.size === 0) {
      set({ failedIds: EMPTY_SET, payload: null, disarmedCount: 0 });
      return;
    }
    set({ failedIds: ids, payload, disarmedCount });
  },
  dismissId: (id) =>
    set((s) => {
      if (!s.failedIds.has(id)) return {};
      const next = new Set(s.failedIds);
      next.delete(id);
      if (next.size === 0) {
        return { failedIds: EMPTY_SET, payload: null, disarmedCount: 0 };
      }
      return { failedIds: next };
    }),
  clear: () => set({ failedIds: EMPTY_SET, payload: null, disarmedCount: 0 }),
}));

/**
 * Auto-clear the failure set when the underlying fleet is cleared. A
 * persistent failure dot on a pane the user just disarmed would be confusing
 * — the action context is gone. We only watch for fleet *drain* (size → 0)
 * to avoid wiping failures when the user is just toggling individual panes.
 *
 * Registered by `initStoreOrchestrator()` so the subscription is scoped to
 * the renderer lifecycle (HMR-safe via the orchestrator's `DisposableStore`)
 * rather than module evaluation. The previous module-scope registration used
 * a `globalThis` flag to dedupe across re-evaluations, but that mishandled
 * HMR teardown — moving the subscription under the orchestrator's idempotent
 * `init`/`destroy` cycle is the canonical pattern (#9923).
 */

/** Drop failure records for panes that are no longer in the armed set. */
function reconcileFleetFailures(currentArmed: Set<string>): void {
  const failed = useFleetFailureStore.getState().failedIds;
  if (failed.size === 0) return;
  // Whole fleet drained — clear everything in one shot to avoid the
  // per-id loop below thrashing the store on every removed pane.
  if (currentArmed.size === 0) {
    useFleetFailureStore.getState().clear();
    return;
  }
  // Per-pane removal — drop the failure record for any pane that's
  // no longer armed. Disarming a pane (manual or via auto-prune of
  // trashed/exited terminals) means the user has moved on; a stale
  // red dot would just create cleanup work.
  for (const id of failed) {
    if (!currentArmed.has(id)) {
      useFleetFailureStore.getState().dismissId(id);
    }
  }
}

export function subscribeFleetFailureAutoClear(): () => void {
  // Initial reconciliation pass: catch up on any armed-set change that
  // happened while the subscription was torn down (orchestrator destroy →
  // mutate → re-init, or HMR). The original module-scope subscription never
  // tore down, so it caught every change; the orchestrator-scoped version
  // can miss a drain or partial disarm during the torn-down window. This
  // pass recovers that invariant on re-registration — mirrors the initial
  // pass in `subscribeFleetArmingPanelPruning` (#9923).
  const initialArmed = useFleetArmingStore.getState().armedIds;
  reconcileFleetFailures(initialArmed);

  let prevArmed = initialArmed;
  return useFleetArmingStore.subscribe((state) => {
    const nextArmed = state.armedIds;
    if (prevArmed === nextArmed) return;
    reconcileFleetFailures(nextArmed);
    prevArmed = nextArmed;
  });
}
