import type { PtyClient } from "../PtyClient.js";
import type { WorkspaceClient } from "../WorkspaceClient.js";
import { getLifecycleLedger } from "./lifecycleLedger.js";
import { journalAgentSession } from "./agentSessionJournal.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:ProjectSessionJournal");

type TerminalInfo = Awaited<ReturnType<PtyClient["getAllTerminalsAsync"]>>[number];

/** How long to wait for a worktree branch lookup before journaling without it. */
const BRANCH_LOOKUP_TIMEOUT_MS = 200;

/**
 * Gracefully tear down every terminal in a project scope (a project id or a
 * scratch id — both are opaque scope ids to the PTY host) and journal each
 * agent's session the way app shutdown does, BEFORE the caller deletes the
 * scope's restoration state.
 *
 * This mirrors the journaling block in `electron/lifecycle/shutdown.ts` at
 * single-scope granularity, minus the projectStore terminal-state writeback:
 * every caller here (project close+kill, project remove, scratch remove) clears
 * or deletes that state immediately, so writing captured session ids back into
 * it would be pointless. The exactly-once journal funnel is what actually keeps
 * the agent conversations resumable from the picker.
 *
 * Returns `confirmed` straight from the kill: when it is false a live host timed
 * out without acknowledging the kill, so the caller MUST fail closed — keep the
 * restoration state / don't remove the entity — or still-running agents are
 * orphaned. `terminalsKilled` counts the terminals the host reported tearing
 * down (0 when the host was already gone).
 *
 * Journaling is best-effort and does NOT gate `confirmed`: a failed pre-kill
 * snapshot, a capture whose terminal info didn't survive the snapshot, or a
 * single journal write that throws all lose that one resume record but never
 * block the teardown the caller asked for — exactly as `shutdown.ts` behaves.
 * The kill confirmation, not journaling success, is what protects restoration
 * state. Losing a resume record is strictly better than the pre-fix behavior,
 * which journaled nothing at all.
 */
export async function gracefulTeardownAndJournalProject(
  scopeId: string,
  ptyClient: PtyClient,
  workspaceClient?: WorkspaceClient
): Promise<{ confirmed: boolean; terminalsKilled: number }> {
  // Snapshot terminal infos for this scope BEFORE the kill — info is gone once
  // the PTY exits. Best-effort: a failed snapshot just skips journaling.
  let infoById = new Map<string, TerminalInfo>();
  try {
    const all = await ptyClient.getAllTerminalsAsync();
    infoById = new Map(all.filter((t) => t.projectId === scopeId).map((t) => [t.id, t]));
  } catch {
    // Snapshot is best-effort; the journal loop below skips when info is absent.
  }

  // Freeze each terminal's launch generation alongside the info snapshot, before
  // any kill — the journal write must stay attributed to the incarnation being
  // torn down, not a respawn that races the close (#10950).
  const ledger = getLifecycleLedger();
  const generationById = new Map<string, number | undefined>(
    [...infoById.keys()].map((id) => [id, ledger.currentGeneration(id)])
  );

  const outcome = await ptyClient.gracefulKillByProjectConfirmed(scopeId);

  const captured = outcome.sessions
    .filter((r) => r.agentSessionId)
    .map((r) => ({ result: r, info: infoById.get(r.id) }))
    .filter((c): c is { result: (typeof c)["result"]; info: NonNullable<(typeof c)["info"]> } =>
      Boolean(c.info?.launchAgentId)
    );

  if (captured.length > 0) {
    // Resolve unique worktree branches in parallel, each time-boxed, so a
    // stalled workspace host can't push this past the caller's budget.
    const uniqueWorktreeIds = [
      ...new Set(
        captured
          .map((c) => c.info.worktreeId)
          .filter((w): w is string => typeof w === "string" && w.length > 0)
      ),
    ];
    const branchByWorktree = new Map<string, string>();
    await Promise.all(
      uniqueWorktreeIds.map(async (wid) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const snapshot = await Promise.race([
            workspaceClient ? workspaceClient.getMonitorAsync(wid) : Promise.resolve(null),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), BRANCH_LOOKUP_TIMEOUT_MS);
            }),
          ]);
          const branch = snapshot?.branch;
          if (branch && branch !== "HEAD") branchByWorktree.set(wid, branch);
        } catch {
          // best-effort
        } finally {
          if (timer) clearTimeout(timer);
        }
      })
    );

    for (const { result, info } of captured) {
      try {
        await journalAgentSession(
          {
            sessionId: result.agentSessionId as string,
            agentId: info.launchAgentId as string,
            worktreeId: info.worktreeId ?? null,
            // Prefer the observed task title, matching the shutdown / kill close
            // paths — except under a user title lock, where the record reads the
            // same as the frozen live tab.
            title:
              (info.titleMode === "user" ? info.title : (info.lastObservedTitle ?? info.title)) ??
              null,
            projectId: info.projectId ?? null,
            agentLaunchFlags: info.agentLaunchFlags,
            agentModelId: info.agentModelId,
            cwd: info.cwd ?? undefined,
            branch: info.worktreeId ? branchByWorktree.get(info.worktreeId) : undefined,
          },
          // `?? null` marks an evicted/unknown generation as explicitly frozen
          // so the journal funnel fails open instead of re-reading a respawn's
          // current generation (#11340).
          { terminalId: result.id, generation: generationById.get(result.id) ?? null }
        );
      } catch (err) {
        // One failed journal write must not block the rest.
        logger.warn(`Failed to journal agent session for ${result.id}`, { err });
      }
    }
  }

  return { confirmed: outcome.confirmed, terminalsKilled: outcome.sessions.length };
}
