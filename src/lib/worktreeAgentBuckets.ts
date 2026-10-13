import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { Project } from "@shared/types/project";
import type { Scratch } from "@shared/types/scratch";
import type { WorktreeState } from "@shared/types/worktree";
import {
  ATTENTION_FILTER_BANDS,
  bandForRun,
  FINISHED_FILTER_BANDS,
  WORKING_FILTER_BANDS,
} from "@/lib/fleetAttention";

/**
 * Which quick-state buckets a worktree belongs to, from the bands of its agents.
 *
 * Every surface that names these buckets — the sidebar's filter and counts, the
 * overview modal, Attention cycling and the card's tick — derives them here,
 * over the same band sets Pilot's segments read, so one word means one set of
 * agents everywhere.
 *
 * - `working`: an agent is working (`running`, or `quiet` — silent but still
 *   working; the sidebar has no Quiet bucket of its own).
 * - `attention`: an agent that isn't parked or snoozed is asking for something —
 *   an approval, a question, or an error. Seeing it answers nothing.
 * - `finished`: nothing is working or asking, and either an agent handed work
 *   back or the PR has merged. An observation, not a verdict: a prompt is also
 *   what a missed approval dialog looks like.
 * - `finishedUnseen`: finished, with a hand-back nobody has looked at yet.
 * - `cleanup`: finished by way of a merged PR.
 *
 * Working and Attention can overlap; Finished excludes both. A worktree whose
 * agents are only parked, snoozed, idle or exited is in none of them.
 */
export interface WorktreeAgentBuckets {
  working: boolean;
  attention: boolean;
  finished: boolean;
  finishedUnseen: boolean;
  cleanup: boolean;
}

export const EMPTY_WORKTREE_AGENT_BUCKETS: WorktreeAgentBuckets = {
  working: false,
  attention: false,
  finished: false,
  finishedUnseen: false,
  cleanup: false,
};

/** Merged, or merged with its issue still linked — the route to cleanup. */
export function isWorktreeMergedForCleanup(worktree: WorktreeState): boolean {
  return (
    !worktree.isMainWorktree &&
    worktree.worktreeChanges !== null &&
    worktree.linked?.pr?.state === "merged"
  );
}

/** Fleet runs keyed by run id, which is the agent panel's own id. */
export function indexFleetRuns(
  runs: readonly FleetRunRow[] | null | undefined
): ReadonlyMap<string, FleetRunRow> {
  const map = new Map<string, FleetRunRow>();
  for (const run of runs ?? []) map.set(run.runId, run);
  return map;
}

/**
 * The completion watermark of the workspace this view owns, which is what Pilot
 * dates an unrecorded hand-back against too. Keyed by the view's own workspace
 * id, never the globally broadcast current selection.
 */
export function viewCompletionWatermark(
  viewWorkspaceId: string | null,
  projects: readonly Pick<Project, "id" | "lastCompletionSeenAt">[],
  scratches: readonly Pick<Scratch, "id" | "lastCompletionSeenAt">[]
): number | undefined {
  if (viewWorkspaceId === null) return undefined;
  return (
    projects.find((p) => p.id === viewWorkspaceId)?.lastCompletionSeenAt ??
    scratches.find((s) => s.id === viewWorkspaceId)?.lastCompletionSeenAt
  );
}

/**
 * Buckets for one worktree.
 *
 * `agentPanelIds` is the surface's own membership — the agent panels it already
 * shows under this worktree — and each is joined to its fleet run by id. That
 * keeps every surface's visibility rules and avoids matching worktree paths,
 * which are not spelled the same way everywhere. A panel the fleet hasn't
 * reported yet contributes nothing: its park, snooze and hand-back facts are
 * unknown, and guessing them would flash a parked agent into Attention.
 */
export function deriveWorktreeAgentBuckets(
  agentPanelIds: Iterable<string>,
  runsById: ReadonlyMap<string, FleetRunRow>,
  acknowledgedAt: number | undefined,
  mergedForCleanup: boolean
): WorktreeAgentBuckets {
  let working = false;
  let attention = false;
  let handedBack = false;
  let unseen = false;
  for (const id of agentPanelIds) {
    const run = runsById.get(id);
    if (!run) continue;
    const band = bandForRun(run, acknowledgedAt);
    if (WORKING_FILTER_BANDS.has(band) || band === "quiet") working = true;
    else if (ATTENTION_FILTER_BANDS.has(band)) attention = true;
    else if (FINISHED_FILTER_BANDS.has(band)) {
      handedBack = true;
      if (band === "review") unseen = true;
    }
  }
  const settled = !working && !attention;
  const finished = settled && (handedBack || mergedForCleanup);
  return {
    working,
    attention,
    finished,
    finishedUnseen: finished && unseen,
    cleanup: settled && mergedForCleanup,
  };
}

const WORKING_BIT = 1;
const ATTENTION_BIT = 2;
const FINISHED_BIT = 4;
const UNSEEN_BIT = 8;
const CLEANUP_BIT = 16;

/**
 * Buckets as one number, for store selectors that must return primitives so a
 * shallow compare can skip the panel churn of a streaming agent.
 */
export function encodeWorktreeAgentBuckets(buckets: WorktreeAgentBuckets): number {
  return (
    (buckets.working ? WORKING_BIT : 0) |
    (buckets.attention ? ATTENTION_BIT : 0) |
    (buckets.finished ? FINISHED_BIT : 0) |
    (buckets.finishedUnseen ? UNSEEN_BIT : 0) |
    (buckets.cleanup ? CLEANUP_BIT : 0)
  );
}

export function decodeWorktreeAgentBuckets(bits: number): WorktreeAgentBuckets {
  return {
    working: (bits & WORKING_BIT) !== 0,
    attention: (bits & ATTENTION_BIT) !== 0,
    finished: (bits & FINISHED_BIT) !== 0,
    finishedUnseen: (bits & UNSEEN_BIT) !== 0,
    cleanup: (bits & CLEANUP_BIT) !== 0,
  };
}
