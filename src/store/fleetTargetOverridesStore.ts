import { create } from "zustand";
import { useFleetArmingStore } from "./fleetArmingStore";

/**
 * Ephemeral per-broadcast state for the fleet drafting popover: lets the
 * user edit one target's resolved payload or skip a target entirely without
 * disarming the fleet. The plumbing in `executeFleetBroadcast` already
 * accepts `perTargetOverrides`; this store is what writes to it.
 *
 * Per-target overrides MUST NOT persist into saved fleet recipes
 * (#8691 constraint) — clear on disarm / popover close / broadcast end.
 *
 * The Enter-broadcast pipeline snapshots `getState()` synchronously at
 * Enter-press time in `tryFleetBroadcastFromEditor` (before `doSend` is
 * invoked) so values are never stale from a closure captured at call time.
 */
interface FleetTargetOverridesState {
  payloadOverrides: Record<string, string>;
  skippedIds: Set<string>;

  setPayloadOverride: (terminalId: string, text: string) => void;
  clearPayloadOverride: (terminalId: string) => void;
  toggleSkipped: (terminalId: string) => void;
  setSkipped: (terminalId: string, skipped: boolean) => void;
  clear: () => void;
}

export const useFleetTargetOverridesStore = create<FleetTargetOverridesState>((set) => ({
  payloadOverrides: {},
  skippedIds: new Set<string>(),

  setPayloadOverride: (terminalId, text) => {
    set((state) => ({
      payloadOverrides: { ...state.payloadOverrides, [terminalId]: text },
    }));
  },

  clearPayloadOverride: (terminalId) => {
    set((state) => {
      if (!(terminalId in state.payloadOverrides)) return state;
      const next = { ...state.payloadOverrides };
      delete next[terminalId];
      return { payloadOverrides: next };
    });
  },

  toggleSkipped: (terminalId) => {
    set((state) => {
      const next = new Set(state.skippedIds);
      if (next.has(terminalId)) next.delete(terminalId);
      else next.add(terminalId);
      return { skippedIds: next };
    });
  },

  setSkipped: (terminalId, skipped) => {
    set((state) => {
      if (skipped === state.skippedIds.has(terminalId)) return state;
      const next = new Set(state.skippedIds);
      if (skipped) next.add(terminalId);
      else next.delete(terminalId);
      return { skippedIds: next };
    });
  },

  clear: () => {
    set({ payloadOverrides: {}, skippedIds: new Set<string>() });
  },
}));

/** Test-only — clears the store so each test starts from a known baseline. */
export function __resetFleetTargetOverridesStoreForTesting(): void {
  useFleetTargetOverridesStore.setState({
    payloadOverrides: {},
    skippedIds: new Set<string>(),
  });
}

/**
 * Per-target overrides pruning subscription. Wires `useFleetArmingStore`
 * changes into this store so a pane that leaves the armed set (manual disarm,
 * or auto-prune of a trashed/exited terminal) also loses any per-target payload
 * override or skip flag it carried. `disarmId` only mutates the arming store,
 * and none of the lifecycle-edge `clear()` calls fire when the drafting popover
 * stays open — so without this reconciliation a disarmed-then-rearmed pane keeps
 * a stale `skippedIds` entry and is silently excluded from the next broadcast
 * (#9973), and `FleetDraftingPill`'s divergence badge shows ghost counts.
 *
 * Registered by `initStoreOrchestrator()` (not module scope) so the
 * subscription is scoped to the renderer lifecycle and HMR-safe via the
 * orchestrator's `DisposableStore` — mirrors `subscribeFleetArmingPanelPruning`.
 *
 * Runs an initial reconciliation pass before subscribing so entries that
 * diverged from the armed set while the subscription was torn down (test
 * destroy → mutate → re-init) get pruned on re-registration.
 */
export function subscribeFleetTargetOverridesPruning(): () => void {
  function pruneAgainst(nextArmed: Set<string>): void {
    const state = useFleetTargetOverridesStore.getState();
    const { payloadOverrides, skippedIds } = state;

    // Whole fleet drained — reset both fields in one shot rather than looping
    // per id. Also the correct re-init behavior: stale entries left from a
    // prior session are wiped when nothing is armed.
    if (nextArmed.size === 0) {
      if (skippedIds.size > 0 || Object.keys(payloadOverrides).length > 0) {
        state.clear();
      }
      return;
    }

    // Per-pane removal — drop overrides/skips for ids no longer armed. Only
    // allocate a replacement container when that field actually loses an entry,
    // so subscribers watching the untouched field keep their ref-equality fast
    // path (mirrors the identity-preserving updates in this store's actions).
    let nextSkipped: Set<string> | null = null;
    for (const id of skippedIds) {
      if (!nextArmed.has(id)) {
        if (!nextSkipped) nextSkipped = new Set(skippedIds);
        nextSkipped.delete(id);
      }
    }

    let nextOverrides: Record<string, string> | null = null;
    for (const id of Object.keys(payloadOverrides)) {
      if (!nextArmed.has(id)) {
        if (!nextOverrides) nextOverrides = { ...payloadOverrides };
        delete nextOverrides[id];
      }
    }

    if (!nextSkipped && !nextOverrides) return;
    const patch: Partial<FleetTargetOverridesState> = {};
    if (nextSkipped) patch.skippedIds = nextSkipped;
    if (nextOverrides) patch.payloadOverrides = nextOverrides;
    useFleetTargetOverridesStore.setState(patch);
  }

  let prevArmed = useFleetArmingStore.getState().armedIds;
  pruneAgainst(prevArmed);

  return useFleetArmingStore.subscribe((state) => {
    const nextArmed = state.armedIds;
    if (prevArmed === nextArmed) return;
    prevArmed = nextArmed;
    pruneAgainst(nextArmed);
  });
}
