import { useMemo } from "react";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { indexFleetRuns } from "@/lib/worktreeAgentBuckets";

export interface WorktreeAgentBucketInputs {
  runsById: ReadonlyMap<string, FleetRunRow>;
}

/**
 * The fleet facts `deriveWorktreeAgentBuckets` joins against. The snapshot only
 * changes on real state transitions (main suppresses unchanged broadcasts), so
 * re-indexing on each one is cheap.
 */
export function useWorktreeAgentBucketInputs(): WorktreeAgentBucketInputs {
  const runs = useFleetSnapshotStore((s) => s.snapshot?.runs ?? null);
  const runsById = useMemo(() => indexFleetRuns(runs), [runs]);
  return { runsById };
}

/** The same inputs, read once, for paths outside React (keyboard cycling). */
export function readWorktreeAgentBucketInputs(): WorktreeAgentBucketInputs {
  return { runsById: indexFleetRuns(useFleetSnapshotStore.getState().snapshot?.runs) };
}
