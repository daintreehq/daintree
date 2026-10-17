import { useShallow } from "zustand/react/shallow";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";

export interface RunParkState {
  parked: boolean;
  note: string | null;
}

/**
 * One run's park, as the snapshot carries it. Presence of `park` on the row IS
 * "parked", so there is no clock to consult. Shallow-compared primitives, so
 * unrelated fleet pushes don't re-render every session row.
 */
export function useRunParkState(terminalId: string): RunParkState {
  return useFleetSnapshotStore(
    useShallow((s) => {
      const park = s.snapshot?.runs.find((run) => run.runId === terminalId)?.park;
      return { parked: park !== undefined, note: park?.note ?? null };
    })
  );
}
