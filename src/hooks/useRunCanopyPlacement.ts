import { useShallow } from "zustand/react/shallow";
import type { RunCanopyRefinement } from "@shared/types/ipc/fleet";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { canopyPlacementForRun } from "@/lib/canopyRefinementPresentation";

/**
 * The Canopy refinement placing one terminal, if any. Compared field by field,
 * so a fleet push that carries the same reading again doesn't re-render.
 */
export function useRunCanopyPlacement(terminalId: string): RunCanopyRefinement | undefined {
  return useFleetSnapshotStore(useShallow((s) => canopyPlacementForRun(s.snapshot, terminalId)));
}
