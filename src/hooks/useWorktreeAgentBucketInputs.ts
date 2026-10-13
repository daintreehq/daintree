import { useMemo } from "react";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { indexFleetRuns, viewCompletionWatermark } from "@/lib/worktreeAgentBuckets";

export interface WorktreeAgentBucketInputs {
  runsById: ReadonlyMap<string, FleetRunRow>;
  acknowledgedAt: number | undefined;
}

/**
 * The fleet facts `deriveWorktreeAgentBuckets` joins against. The snapshot only
 * changes on real state transitions (main suppresses unchanged broadcasts), so
 * re-indexing on each one is cheap.
 */
export function useWorktreeAgentBucketInputs(): WorktreeAgentBucketInputs {
  const runs = useFleetSnapshotStore((s) => s.snapshot?.runs ?? null);
  const viewWorkspaceId = getViewWorkspaceId();
  const acknowledgedAt = useProjectStore((s) =>
    viewCompletionWatermark(viewWorkspaceId, s.projects, [])
  );
  const scratchAcknowledgedAt = useScratchStore((s) =>
    viewCompletionWatermark(viewWorkspaceId, [], s.scratches)
  );
  const runsById = useMemo(() => indexFleetRuns(runs), [runs]);
  return { runsById, acknowledgedAt: acknowledgedAt ?? scratchAcknowledgedAt };
}

/** The same inputs, read once, for paths outside React (keyboard cycling). */
export function readWorktreeAgentBucketInputs(): WorktreeAgentBucketInputs {
  const viewWorkspaceId = getViewWorkspaceId();
  return {
    runsById: indexFleetRuns(useFleetSnapshotStore.getState().snapshot?.runs),
    acknowledgedAt: viewCompletionWatermark(
      viewWorkspaceId,
      useProjectStore.getState().projects,
      useScratchStore.getState().scratches
    ),
  };
}
