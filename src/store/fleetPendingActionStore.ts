import { create } from "zustand";

/**
 * Ephemeral UI state for fleet quick-action confirmations. Fleet actions
 * that need confirmation (interrupt ≥3, restart/kill always, trash ≥5) set
 * this store instead of running immediately; FleetArmingRibbon subscribes
 * and renders inline confirmation UI that dispatches the action again with
 * `{ confirmed: true }` on Enter or clears the store on Escape.
 *
 * The store is not persisted — a pending confirmation dies with the
 * current session.
 */
export type FleetPendingActionKind = "reject" | "interrupt" | "restart" | "kill" | "trash";

export interface FleetPendingActionSnapshot {
  kind: FleetPendingActionKind;
  targetCount: number;
  sessionLossCount: number;
}

interface FleetPendingActionState {
  pending: FleetPendingActionSnapshot | null;
  request: (snapshot: FleetPendingActionSnapshot) => void;
  clear: () => void;
}

export const useFleetPendingActionStore = create<FleetPendingActionState>((set) => ({
  pending: null,
  request: (snapshot) => set({ pending: snapshot }),
  clear: () => set({ pending: null }),
}));
