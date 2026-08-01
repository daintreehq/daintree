import { create } from "zustand";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

interface FleetSnapshotState {
  /**
   * Null until main's first push or pull lands.
   *
   * Deliberately distinct from a snapshot holding an empty `runs` array: the
   * first means "nothing has been reported yet" and the second means "the fleet
   * is genuinely empty". Only the second may render as all-clear, so the two
   * cannot share a representation.
   */
  snapshot: FleetSnapshot | null;
  /** Apply a pushed snapshot. Pushes are authoritative and always win. */
  applySnapshot: (snapshot: FleetSnapshot) => void;
  /**
   * Apply a pulled snapshot.
   *
   * Resolved by provenance, not by timestamp. `changedAt` is stamped with
   * `Date.now()` in main, so it is display semantics and not a sequence number:
   * ordering on it would freeze the view for an hour if the system clock were
   * corrected backwards.
   *
   * Ordering against pushes is the caller's job — see `pushLandedGeneration`.
   * Guarding on `snapshot !== null` here instead looks equivalent and is not:
   * after a teardown and re-subscribe the store still holds the OLD view's
   * snapshot, so a non-null store would reject the very pull that exists to
   * replace it, and the view would keep rendering pre-remount data until the
   * fleet next changed.
   */
  applyHydrate: (snapshot: FleetSnapshot) => void;
}

export const useFleetSnapshotStore = create<FleetSnapshotState>((set) => ({
  snapshot: null,
  applySnapshot: (snapshot) => set({ snapshot }),
  applyHydrate: (snapshot) => set({ snapshot }),
}));

let snapshotUnsubscribe: (() => void) | null = null;
/**
 * Bumped on every setup and teardown so a pull started by an earlier setup
 * cannot repopulate the store after cleanup. StrictMode runs
 * setup → cleanup → setup as a matter of course, so this is a routine path,
 * not a corner case.
 */
let setupGeneration = 0;
/**
 * The setup generation whose push has already reached the store, so a pull that
 * resolves afterwards knows it is redundant rather than merely late.
 */
let pushLandedGeneration = -1;

/**
 * Wire the fleet snapshot: subscribe, then hydrate.
 *
 * Both halves are required. Main suppresses unchanged broadcasts, so a view
 * that only subscribes can wait indefinitely for a first payload — and the
 * states that stop changing (waiting, blocked, awaiting review) are exactly the
 * ones worth seeing. Subscribing first means the pull can only ever be
 * redundant, never a gap.
 */
export function setupFleetSnapshotListeners(): () => void {
  if (typeof window === "undefined") return () => {};
  if (snapshotUnsubscribe !== null) return cleanupFleetSnapshotListeners;

  const generation = ++setupGeneration;

  snapshotUnsubscribe = window.electron.fleet.onSnapshotUpdated((snapshot) => {
    pushLandedGeneration = generation;
    useFleetSnapshotStore.getState().applySnapshot(snapshot);
  });

  safeFireAndForget(
    window.electron.fleet.getSnapshot().then((snapshot) => {
      if (generation !== setupGeneration) return;
      // A push for THIS subscription already delivered a newer view.
      if (pushLandedGeneration === generation) return;
      // Null means main hasn't computed yet; leaving the store null keeps
      // "not reported" distinct from "fleet clear".
      if (snapshot) useFleetSnapshotStore.getState().applyHydrate(snapshot);
    }),
    // Reported rather than swallowed: the push path still recovers this view
    // the next time the fleet changes, but a hydrate that keeps failing is why
    // a cold view would sit empty, and that should not be silent.
    { context: "fleetSnapshotStore hydrate" }
  );

  return cleanupFleetSnapshotListeners;
}

export function cleanupFleetSnapshotListeners(): void {
  setupGeneration++;
  if (snapshotUnsubscribe) {
    snapshotUnsubscribe();
    snapshotUnsubscribe = null;
  }
}
