import { useShallow } from "zustand/react/shallow";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { handBackStateForRun, type HandBackSeenState } from "@/lib/handBackPresentation";

/** One terminal's hand-back state. A primitive, so unrelated fleet changes don't re-render. */
export function useRunHandBackState(terminalId: string): HandBackSeenState {
  return useFleetSnapshotStore((s) => handBackStateForRun(s.snapshot, terminalId));
}

/** Hand-back states for several terminals, in the order given. */
export function useRunHandBackStates(terminalIds: readonly string[]): HandBackSeenState[] {
  return useFleetSnapshotStore(
    useShallow((s) => terminalIds.map((id) => handBackStateForRun(s.snapshot, id)))
  );
}
