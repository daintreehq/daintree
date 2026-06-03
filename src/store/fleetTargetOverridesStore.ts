import { create } from "zustand";

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
