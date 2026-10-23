import { useMemo } from "react";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { indexFleetRuns } from "@/lib/worktreeAgentBuckets";
import type { PluginWorktreeAttention } from "@/lib/pluginPanelAttention";
import {
  readPluginWorktreeAttention,
  usePluginWorktreeAttention,
} from "@/hooks/usePluginPanelAttentionRows";

export interface WorktreeAgentBucketInputs {
  runsById: ReadonlyMap<string, FleetRunRow>;
  /** Plugin panel rows by worktree (#13821), folded into the same buckets. */
  pluginByWorktreeId: ReadonlyMap<string, PluginWorktreeAttention>;
}

/**
 * The fleet facts `deriveWorktreeAgentBuckets` joins against. The snapshot only
 * changes on real state transitions (main suppresses unchanged broadcasts), so
 * re-indexing on each one is cheap.
 */
export function useWorktreeAgentBucketInputs(): WorktreeAgentBucketInputs {
  const runs = useFleetSnapshotStore((s) => s.snapshot?.runs ?? null);
  const runsById = useMemo(() => indexFleetRuns(runs), [runs]);
  const pluginByWorktreeId = usePluginWorktreeAttention();
  return useMemo(() => ({ runsById, pluginByWorktreeId }), [runsById, pluginByWorktreeId]);
}

/** The same inputs, read once, for paths outside React (keyboard cycling). */
export function readWorktreeAgentBucketInputs(): WorktreeAgentBucketInputs {
  return {
    runsById: indexFleetRuns(useFleetSnapshotStore.getState().snapshot?.runs),
    pluginByWorktreeId: readPluginWorktreeAttention(),
  };
}
