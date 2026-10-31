import { useMemo } from "react";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import {
  decodeWorktreeAgentBuckets,
  deriveWorktreeAgentBuckets,
  encodeWorktreeAgentBuckets,
  indexFleetRuns,
  type WorktreeAgentBuckets,
} from "@/lib/worktreeAgentBuckets";
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
 * The fleet facts `deriveWorktreeAgentBuckets` joins against, for surfaces that
 * derive buckets for many worktrees at once. It re-renders on every fleet push,
 * so a surface that shows one worktree reads `useWorktreeAgentBuckets` instead.
 */
export function useWorktreeAgentBucketInputs(): WorktreeAgentBucketInputs {
  const runs = useFleetSnapshotStore((s) => s.snapshot?.runs ?? null);
  const runsById = indexFleetRuns(runs);
  const pluginByWorktreeId = usePluginWorktreeAttention();
  return useMemo(() => ({ runsById, pluginByWorktreeId }), [runsById, pluginByWorktreeId]);
}

/**
 * One worktree's buckets. The fleet selector returns the encoded bits, so a
 * push re-renders the caller only when this worktree's buckets moved. Plugin
 * attention, which changes apart from the fleet, still reaches it through its
 * own subscription.
 */
export function useWorktreeAgentBuckets(
  agentPanelIds: readonly string[],
  mergedForCleanup: boolean,
  worktreeId: string
): WorktreeAgentBuckets {
  const plugin = usePluginWorktreeAttention().get(worktreeId);
  const bits = useFleetSnapshotStore((s) =>
    encodeWorktreeAgentBuckets(
      deriveWorktreeAgentBuckets(
        agentPanelIds,
        indexFleetRuns(s.snapshot?.runs),
        mergedForCleanup,
        plugin
      )
    )
  );
  return useMemo(() => decodeWorktreeAgentBuckets(bits), [bits]);
}

/** The same inputs, read once, for paths outside React (keyboard cycling). */
export function readWorktreeAgentBucketInputs(): WorktreeAgentBucketInputs {
  return {
    runsById: indexFleetRuns(useFleetSnapshotStore.getState().snapshot?.runs),
    pluginByWorktreeId: readPluginWorktreeAttention(),
  };
}
