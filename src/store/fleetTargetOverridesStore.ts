import { create } from "zustand";
import { useFleetArmingStore } from "./fleetArmingStore";

/**
 * Ephemeral per-broadcast state for the fleet drafting popover: lets the
 * user edit one target's resolved payload or skip a target entirely without
 * disarming the fleet. The plumbing in `executeFleetBroadcast` already
 * accepts `perTargetOverrides`; this store is what writes to it.
 *
 * Per-target overrides MUST NOT persist into saved fleet recipes
 * (#8691 constraint) — clear on disarm / popover close, and a broadcast
 * consumes the edits it sent once it settles.
 *
 * The Enter-broadcast pipeline takes a `snapshot()` synchronously at
 * Enter-press time in `tryFleetBroadcastFromEditor` (before `doSend` is
 * invoked) so values are never stale from a closure captured at call time.
 */
interface FleetTargetOverridesState {
  payloadOverrides: Record<string, string>;
  skippedIds: Set<string>;
  /** The revision each override was last set at, for `consumeSnapshot`. */
  payloadRevisions: Record<string, number>;
  /** The revision each skip was last set at, for `consumeSnapshot`. */
  skipRevisions: Record<string, number>;

  setPayloadOverride: (terminalId: string, text: string) => void;
  clearPayloadOverride: (terminalId: string) => void;
  toggleSkipped: (terminalId: string) => void;
  setSkipped: (terminalId: string, skipped: boolean) => void;
  clear: () => void;
  snapshot: () => FleetTargetOverridesSnapshot;
  consumeSnapshot: (snapshot: FleetTargetOverridesSnapshot) => void;
}

/** The edits one broadcast took at Enter, and the revision they stood at. */
export interface FleetTargetOverridesSnapshot {
  readonly payloadOverrides: Readonly<Record<string, string>>;
  readonly skippedIds: ReadonlySet<string>;
  readonly revision: number;
}

// Never reset, not even by `clear()`: an entry set after a clear must still
// read as newer than a snapshot a send took before it.
let lastRevision = 0;

function withRevision(revisions: Record<string, number>, id: string): Record<string, number> {
  lastRevision += 1;
  return { ...revisions, [id]: lastRevision };
}

function withoutRevision(revisions: Record<string, number>, id: string): Record<string, number> {
  if (!Object.hasOwn(revisions, id)) return revisions;
  const next = { ...revisions };
  delete next[id];
  return next;
}

export const useFleetTargetOverridesStore = create<FleetTargetOverridesState>((set, get) => ({
  payloadOverrides: {},
  skippedIds: new Set<string>(),
  payloadRevisions: {},
  skipRevisions: {},

  setPayloadOverride: (terminalId, text) => {
    set((state) => ({
      payloadOverrides: { ...state.payloadOverrides, [terminalId]: text },
      payloadRevisions: withRevision(state.payloadRevisions, terminalId),
    }));
  },

  clearPayloadOverride: (terminalId) => {
    set((state) => {
      if (!Object.hasOwn(state.payloadOverrides, terminalId)) return state;
      const next = { ...state.payloadOverrides };
      delete next[terminalId];
      return {
        payloadOverrides: next,
        payloadRevisions: withoutRevision(state.payloadRevisions, terminalId),
      };
    });
  },

  toggleSkipped: (terminalId) => {
    const { skippedIds, setSkipped } = get();
    setSkipped(terminalId, !skippedIds.has(terminalId));
  },

  setSkipped: (terminalId, skipped) => {
    set((state) => {
      if (skipped === state.skippedIds.has(terminalId)) return state;
      const next = new Set(state.skippedIds);
      if (skipped) next.add(terminalId);
      else next.delete(terminalId);
      return {
        skippedIds: next,
        skipRevisions: skipped
          ? withRevision(state.skipRevisions, terminalId)
          : withoutRevision(state.skipRevisions, terminalId),
      };
    });
  },

  clear: () => {
    set({
      payloadOverrides: {},
      skippedIds: new Set<string>(),
      payloadRevisions: {},
      skipRevisions: {},
    });
  },

  snapshot: () => {
    const { payloadOverrides, skippedIds } = get();
    return {
      payloadOverrides: { ...payloadOverrides },
      skippedIds: new Set(skippedIds),
      revision: lastRevision,
    };
  },

  // Drops only what the snapshot holds and nobody has set since: an edit or
  // exclusion made while its send was out is for the next draft (#17518).
  consumeSnapshot: (snapshot) => {
    set((state) => {
      const taken = (revisions: Record<string, number>, id: string) =>
        (revisions[id] ?? 0) <= snapshot.revision;

      let payloadOverrides = state.payloadOverrides;
      let payloadRevisions = state.payloadRevisions;
      for (const id of Object.keys(snapshot.payloadOverrides)) {
        if (!Object.hasOwn(payloadOverrides, id) || !taken(payloadRevisions, id)) continue;
        if (payloadOverrides === state.payloadOverrides) {
          payloadOverrides = { ...payloadOverrides };
          payloadRevisions = { ...payloadRevisions };
        }
        delete payloadOverrides[id];
        delete payloadRevisions[id];
      }

      let skippedIds = state.skippedIds;
      let skipRevisions = state.skipRevisions;
      for (const id of snapshot.skippedIds) {
        if (!skippedIds.has(id) || !taken(skipRevisions, id)) continue;
        if (skippedIds === state.skippedIds) {
          skippedIds = new Set(skippedIds);
          skipRevisions = { ...skipRevisions };
        }
        skippedIds.delete(id);
        delete skipRevisions[id];
      }

      if (payloadOverrides === state.payloadOverrides && skippedIds === state.skippedIds) {
        return state;
      }
      return { payloadOverrides, payloadRevisions, skippedIds, skipRevisions };
    });
  },
}));

/** Test-only — clears the store so each test starts from a known baseline. */
export function __resetFleetTargetOverridesStoreForTesting(): void {
  useFleetTargetOverridesStore.setState({
    payloadOverrides: {},
    skippedIds: new Set<string>(),
    payloadRevisions: {},
    skipRevisions: {},
  });
}

/**
 * Per-target overrides pruning subscription. Wires `useFleetArmingStore`
 * changes into this store so a target that leaves the fleet (manual disarm,
 * auto-prune of a trashed/exited terminal, or another host's agent dropped)
 * also loses any per-target payload override or skip flag it carried. Another
 * host's agent is keyed by its host-qualified key beside this view's panes, so
 * its entries outlive changes to the local armed set (#17182). `disarmId` only mutates the arming store,
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
  function fleetTargetIds(state: ReturnType<typeof useFleetArmingStore.getState>) {
    if (state.crossHostTargets.length === 0) return state.armedIds;
    const ids = new Set(state.armedIds);
    for (const target of state.crossHostTargets) ids.add(target.key);
    return ids;
  }

  function pruneAgainst(nextArmed: ReadonlySet<string>): void {
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

    // Per-target removal — drop overrides/skips for ids no longer armed. Only
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
    const stillArmed = (revisions: Record<string, number>) =>
      Object.fromEntries(Object.entries(revisions).filter(([id]) => nextArmed.has(id)));
    const patch: Partial<FleetTargetOverridesState> = {};
    if (nextSkipped) {
      patch.skippedIds = nextSkipped;
      patch.skipRevisions = stillArmed(state.skipRevisions);
    }
    if (nextOverrides) {
      patch.payloadOverrides = nextOverrides;
      patch.payloadRevisions = stillArmed(state.payloadRevisions);
    }
    useFleetTargetOverridesStore.setState(patch);
  }

  pruneAgainst(fleetTargetIds(useFleetArmingStore.getState()));

  return useFleetArmingStore.subscribe((state, prev) => {
    if (state.armedIds === prev.armedIds && state.crossHostTargets === prev.crossHostTargets)
      return;
    pruneAgainst(fleetTargetIds(state));
  });
}
