import { create } from "zustand";

/**
 * Single in-flight broadcast that's waiting for the user to confirm
 * (destructive command, multi-line, or over-byte payload). Fed by both
 * the live-paste path and the Enter-broadcast path. The fleet ribbon
 * subscribes and renders the confirm controls in-place.
 *
 * Lives outside the ribbon's local state so any caller (paste handler,
 * input bar, future scriptable broadcasts) can request a confirm without
 * a callback prop chain.
 */
export interface PendingFleetBroadcast {
  text: string;
  /** Human-readable warnings to surface in the confirm prompt. */
  warningReasons: string[];
  /** Caller-provided send action. The ribbon awaits this on confirm. */
  onConfirm: () => Promise<void> | void;
}

interface FleetBroadcastConfirmState {
  pending: PendingFleetBroadcast | null;
  request: (entry: PendingFleetBroadcast) => void;
  clear: () => void;
}

export const useFleetBroadcastConfirmStore = create<FleetBroadcastConfirmState>((set) => ({
  pending: null,
  request: (entry) => set({ pending: entry }),
  clear: () => set({ pending: null }),
}));
