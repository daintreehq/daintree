import type { CanopyRunTarget, CanopyWorktreeReading } from "../../../shared/types/ipc/canopy.js";
import type { FleetRunRow } from "../../../shared/types/ipc/fleet.js";
import { readWorktreesLocalWork, type WorktreeLocalWorkOptions } from "../git/worktreeLocalWork.js";

/**
 * How long one ask may read git for: inside the bulk trash's own five-second
 * wait, with room for the answer to cross a link. What hasn't answered by
 * then reads as unreadable, and its git calls are stopped.
 */
export const CANOPY_WORKTREE_READ_DEADLINE_MS = 4_500;

/**
 * What each run's worktree holds that exists only on this machine (#18151),
 * so a bulk trash can leave unpushed or uncommitted work unticked. Only runs
 * the fleet holds in the same incarnation are answered for; the worktree and
 * project are the fleet's, never the caller's.
 */
export async function readRunWorktrees(
  runs: readonly Pick<FleetRunRow, "runId" | "spawnedAt" | "workspaceId" | "worktreeId">[],
  targets: readonly CanopyRunTarget[],
  projectPathOf: (workspaceId: string) => string | null,
  options: WorktreeLocalWorkOptions = { deadlineMs: CANOPY_WORKTREE_READ_DEADLINE_MS }
): Promise<CanopyWorktreeReading[]> {
  const byIncarnation = new Map(runs.map((run) => [`${run.runId}\u0000${run.spawnedAt}`, run]));
  const known: Array<Pick<FleetRunRow, "runId" | "workspaceId" | "worktreeId">> = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const run = byIncarnation.get(`${target.runId}\u0000${target.spawnedAt}`);
    if (run === undefined || seen.has(run.runId)) continue;
    seen.add(run.runId);
    known.push(run);
  }
  const work = await readWorktreesLocalWork(
    known.map((run) => ({
      projectPath: projectPathOf(run.workspaceId),
      worktreeId: run.worktreeId,
    })),
    options
  );
  return known.map((run, index) => ({ runId: run.runId, work: work[index]! }));
}
