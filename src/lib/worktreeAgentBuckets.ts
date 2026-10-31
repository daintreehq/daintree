import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { WorktreeState } from "@shared/types/worktree";
import { ATTENTION_FILTER_BANDS, bandForRun, FINISHED_FILTER_BANDS } from "@/lib/fleetAttention";
import type { PluginWorktreeAttention } from "@/lib/pluginPanelAttention";

/**
 * Which quick-state buckets a worktree belongs to, from the bands of its agents.
 *
 * Every surface that names these buckets — the sidebar's filter and counts, the
 * overview modal, Attention cycling and the card's tick — derives them here,
 * over the same band sets Pilot's segments read, so one word means one set of
 * agents everywhere.
 *
 * - `working`: an agent is working — including a quiet one, and one that is
 *   parked or snoozed; the sidebar has no Quiet bucket of its own.
 * - `attention`: an agent that isn't parked or snoozed is asking for something —
 *   an approval, a question, or an error. Seeing it answers nothing.
 * - `finished`: nothing is working or asking, and either an agent handed work
 *   back or the PR has merged. An observation, not a verdict: a prompt is also
 *   what a missed approval dialog looks like.
 * - `finishedUnseen`: finished, with a hand-back nobody has looked at yet.
 * - `cleanup`: finished by way of a merged PR.
 *
 * Working and Attention can overlap; Finished excludes both. A worktree whose
 * agents are only idle, exited, or parked or snoozed while stopped is in none
 * of them.
 *
 * Plugin panels the user let into the attention views (#13821) count in the
 * same buckets by the same bands, folded in before Finished is decided — a
 * plugin still waiting keeps its worktree out of Finished, exactly as an agent
 * would.
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
export function isWorktreeMergedForCleanup(
  worktree: Pick<WorktreeState, "isMainWorktree" | "worktreeChanges" | "linked">
): boolean {
  return (
    !worktree.isMainWorktree &&
    worktree.worktreeChanges !== null &&
    worktree.linked?.pr?.state === "merged"
  );
}

const EMPTY_RUNS_BY_ID: ReadonlyMap<string, FleetRunRow> = new Map();
const runsByIdCache = new WeakMap<readonly FleetRunRow[], ReadonlyMap<string, FleetRunRow>>();

/**
 * Fleet runs keyed by run id, which is the agent panel's own id.
 *
 * Cached by array identity: a snapshot is replaced, never mutated, so every
 * card, the sidebar model and cycling share one index per push instead of each
 * building its own over the whole fleet.
 */
export function indexFleetRuns(
  runs: readonly FleetRunRow[] | null | undefined
): ReadonlyMap<string, FleetRunRow> {
  if (!runs || runs.length === 0) return EMPTY_RUNS_BY_ID;
  const cached = runsByIdCache.get(runs);
  if (cached) return cached;
  const map = new Map<string, FleetRunRow>();
  for (const run of runs) map.set(run.runId, run);
  runsByIdCache.set(runs, map);
  return map;
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
  mergedForCleanup: boolean,
  plugin?: PluginWorktreeAttention
): WorktreeAgentBuckets {
  let working = plugin?.working ?? false;
  let attention = plugin?.attention ?? false;
  let handedBack = plugin?.finished ?? false;
  let unseen = plugin?.unseen ?? false;
  for (const id of agentPanelIds) {
    const run = runsById.get(id);
    if (!run) continue;
    // Working is read off the state, not the band: a park or snooze shelves an
    // agent's demands, not its work, and a snoozed agent still running must
    // never let its worktree read as finished.
    if (run.agentState === "working" || run.agentState === "directing") {
      working = true;
      continue;
    }
    const band = bandForRun(run);
    if (ATTENTION_FILTER_BANDS.has(band)) attention = true;
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
