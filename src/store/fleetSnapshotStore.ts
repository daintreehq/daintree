import { create } from "zustand";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";

interface FleetSnapshotState {
  /**
   * Null until main's first push lands.
   *
   * Deliberately distinct from a snapshot holding an empty `runs` array: the
   * first means "nothing has been reported yet" and the second means "the fleet
   * is genuinely empty". Only the second may render as all-clear, so the two
   * cannot share a representation.
   */
  snapshot: FleetSnapshot | null;
  setSnapshot: (snapshot: FleetSnapshot) => void;
}

export const useFleetSnapshotStore = create<FleetSnapshotState>((set) => ({
  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot }),
}));

let snapshotUnsubscribe: (() => void) | null = null;

export function setupFleetSnapshotListeners(): () => void {
  if (typeof window === "undefined") return () => {};
  if (snapshotUnsubscribe !== null) return cleanupFleetSnapshotListeners;

  snapshotUnsubscribe = window.electron.fleet.onSnapshotUpdated((snapshot) => {
    useFleetSnapshotStore.getState().setSnapshot(snapshot);
  });

  return cleanupFleetSnapshotListeners;
}

export function cleanupFleetSnapshotListeners(): void {
  if (snapshotUnsubscribe) {
    snapshotUnsubscribe();
    snapshotUnsubscribe = null;
  }
}
