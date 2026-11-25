import { projectIdFromSlotKey, slotFromSlotKey } from "../../../shared/config/assistantSlots.js";
import {
  isGlobalAssistantId,
  isGlobalAssistantSlot,
  type GlobalAssistantSlot,
} from "../../../shared/config/globalAssistant.js";
import type { LaunchResumeBatch } from "../PendingHelpHibernationStore.js";
import type { AssistantLaunchRequest, AssistantLaunchResult } from "./assistantLaunch.js";

// Each start is a billed CLI and a spawn competing with the panes the launch
// restores; all at once would queue behind the spawn limiter anyway.
const CONCURRENT_RESUMES = 3;

export interface UpdateRestartResumeDeps {
  /**
   * Claims the lane's pointer the way a view's resume does, so no view resumes
   * the same conversation alongside it, and has a view's own automatic launch
   * stand down until the lane is back. Null when the lane has none, runs an
   * assistant, or another resume holds it.
   */
  claim(
    projectId: string,
    slot: number
  ): Promise<{ agentId: string; agentSessionId: string; cwd: string; claimId: string } | null>;
  /** Hands an unspent claim back; a no-op once the resumed lane's spawn has spent it. */
  release(projectId: string, slot: number, claimId: string): Promise<void>;
  /** Whether the claim still holds the pointer: discarding the lane drops it. */
  holdsClaim(projectId: string, slot: number, claimId: string): boolean;
  start(request: AssistantLaunchRequest): Promise<AssistantLaunchResult>;
  isShuttingDown(): boolean;
  /**
   * Whether a lane back because it is kept running across restarts is still
   * kept (#18177): one turned off since stays down. Absent, every one is.
   */
  isKept?(projectId: string, slot: number): boolean;
}

export type UpdateRestartLaneOutcome =
  | { projectId: string; slot: number; status: "resumed" }
  | {
      projectId: string;
      slot: number;
      status: "skipped";
      reason: "shutting-down" | "unclaimed" | "moved-on" | "no-longer-kept";
    }
  | { projectId: string; slot: number; status: "refused"; reason: string };

interface RecordedLane {
  projectId: string;
  slot: number;
  agentSessionId: string;
  /** Back because it is kept running across restarts, not because of an update (#18177). */
  standing: boolean;
}

/**
 * Resumes the project Assistant lanes the previous run left to resume, each
 * into the conversation it was running, with no view, as a schedule's
 * Assistant starts: the first view of its project takes it over. Those are
 * the lanes a restart to install an update stopped (#16753), and the lanes
 * kept running across restarts that were running when any quit or crash
 * ended it (#18177). A lane whose pointer has moved on, whose agent can't
 * start that way, or whose conversation can't be reopened stays down with its
 * pointer kept, to be resumed by hand as after any other restart; nothing
 * starts fresh in its place. The global sessions go through their own start.
 */
export async function resumeLanesAfterUpdate(
  record: Pick<LaunchResumeBatch, "lanes"> & { standing?: ReadonlySet<string> },
  deps: UpdateRestartResumeDeps
): Promise<UpdateRestartLaneOutcome[]> {
  const lanes: RecordedLane[] = Object.entries(record.lanes).flatMap(
    ([slotKey, agentSessionId]) => {
      const projectId = projectIdFromSlotKey(slotKey);
      const slot = slotFromSlotKey(slotKey);
      const standing = record.standing?.has(slotKey) === true;
      return projectId && !isGlobalAssistantId(projectId) && slot !== null
        ? [{ projectId, slot, agentSessionId, standing }]
        : [];
    }
  );
  const outcomes: UpdateRestartLaneOutcome[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < lanes.length) {
      const lane = lanes[next++]!;
      outcomes.push(await resumeLane(lane, deps));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENT_RESUMES, lanes.length) }, () => worker())
  );
  return outcomes;
}

async function resumeLane(
  lane: RecordedLane,
  deps: UpdateRestartResumeDeps
): Promise<UpdateRestartLaneOutcome> {
  const { projectId, slot } = lane;
  if (deps.isShuttingDown()) return { projectId, slot, status: "skipped", reason: "shutting-down" };
  const stillKept = () => !lane.standing || deps.isKept?.(projectId, slot) !== false;
  if (!stillKept()) return { projectId, slot, status: "skipped", reason: "no-longer-kept" };
  const claim = await deps.claim(projectId, slot).catch(() => null);
  if (!claim) return { projectId, slot, status: "skipped", reason: "unclaimed" };
  try {
    // Discarded or relaunched since the quit recorded it.
    if (claim.agentSessionId !== lane.agentSessionId) {
      return { projectId, slot, status: "skipped", reason: "moved-on" };
    }
    const result = await deps
      .start({
        projectId,
        slot,
        agentId: claim.agentId,
        startedBy: { kind: lane.standing ? "standing-restart" : "update-restart" },
        resume: { agentSessionId: claim.agentSessionId, cwd: claim.cwd, claimId: claim.claimId },
        stillWanted: () =>
          !deps.isShuttingDown() && stillKept() && deps.holdsClaim(projectId, slot, claim.claimId),
      })
      .catch((): AssistantLaunchResult => ({ status: "refused", reason: "launch-failed" }));
    return result.status === "started"
      ? { projectId, slot, status: "resumed" }
      : { projectId, slot, status: "refused", reason: result.reason };
  } finally {
    await deps.release(projectId, slot, claim.claimId).catch(() => {});
  }
}

const refusalReason = (err: unknown): string =>
  err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : "failed";

export interface GlobalSessionResumeDeps {
  /** Reopen exactly this conversation in the session, refusing rather than starting another. */
  resume(slot: GlobalAssistantSlot, agentSessionId: string): Promise<void>;
  isKept(slot: GlobalAssistantSlot): boolean;
  isShuttingDown(): boolean;
}

export type GlobalSessionResumeOutcome =
  | { slot: GlobalAssistantSlot; status: "resumed" }
  | { slot: GlobalAssistantSlot; status: "skipped"; reason: "shutting-down" | "no-longer-kept" }
  | { slot: GlobalAssistantSlot; status: "refused"; reason: string };

/**
 * Resumes the global Assistant sessions kept running across restarts that
 * were running when the previous run ended (#18177), each through the start
 * a window's Start uses, reopening the conversation it ran or nothing.
 */
export async function resumeGlobalSessionsAtLaunch(
  record: Pick<LaunchResumeBatch, "lanes">,
  deps: GlobalSessionResumeDeps
): Promise<GlobalSessionResumeOutcome[]> {
  const outcomes: GlobalSessionResumeOutcome[] = [];
  for (const [slotKey, agentSessionId] of Object.entries(record.lanes)) {
    const projectId = projectIdFromSlotKey(slotKey);
    const slot = slotFromSlotKey(slotKey);
    if (!projectId || !isGlobalAssistantId(projectId) || !isGlobalAssistantSlot(slot)) continue;
    if (deps.isShuttingDown()) {
      outcomes.push({ slot, status: "skipped", reason: "shutting-down" });
    } else if (!deps.isKept(slot)) {
      outcomes.push({ slot, status: "skipped", reason: "no-longer-kept" });
    } else {
      outcomes.push(
        await deps.resume(slot, agentSessionId).then(
          () => ({ slot, status: "resumed" as const }),
          (err: unknown) => ({ slot, status: "refused" as const, reason: refusalReason(err) })
        )
      );
    }
  }
  return outcomes;
}

/**
 * Resumes what the previous run left to resume, with the app's own services,
 * loaded only when there is something to resume. In crash-loop safe mode the
 * lanes kept running stay down: one of them may be what keeps crashing.
 */
export async function resumeLanesAfterUpdateLive(batch: LaunchResumeBatch): Promise<void> {
  const [
    { helpSessionService },
    { startAssistantWithoutView, liveAssistantLaunchDeps },
    { getActiveShutdown },
    { logInfo },
    { getCrashLoopGuard },
    { GLOBAL_ASSISTANT_ID },
  ] = await Promise.all([
    import("../HelpSessionService.js"),
    import("./assistantLaunch.js"),
    import("../../lifecycle/shutdownCoordinator.js"),
    import("../../utils/logger.js"),
    import("../CrashLoopGuardService.js"),
    import("../../../shared/config/globalAssistant.js"),
  ]);
  const safeMode = getCrashLoopGuard().isSafeMode();
  const record = safeMode
    ? {
        lanes: Object.fromEntries(
          Object.entries(batch.lanes).filter(([slotKey]) => !batch.standing.has(slotKey))
        ),
        standing: new Set<string>(),
      }
    : batch;
  const isShuttingDown = () => getActiveShutdown() !== null;
  // The global sessions start beside the project lanes, not ahead of them.
  const globalOutcomes = resumeGlobalSessionsAtLaunch(record, {
    resume: async (slot, agentSessionId) => {
      const { getGlobalAssistantService, whenGlobalAssistantSessionsReadable } =
        await import("../globalAssistant.js");
      if (!(await whenGlobalAssistantSessionsReadable())) throw new Error("not readable");
      await getGlobalAssistantService(slot).resumeAfterRestart(agentSessionId);
    },
    isKept: (slot) => helpSessionService.isLaneKeptRunning(GLOBAL_ASSISTANT_ID, slot),
    isShuttingDown,
  });
  const launchDeps = await liveAssistantLaunchDeps();
  const releases = new Map<string, () => Promise<void>>();
  const outcomes = await resumeLanesAfterUpdate(record, {
    claim: async (projectId, slot) => {
      const claim = await helpSessionService.claimLaneResume(projectId, slot);
      if (claim.status !== "claimed") return null;
      releases.set(claim.claimId, claim.release);
      const { agentId, agentSessionId, cwd, claimId } = claim;
      return { agentId, agentSessionId, cwd, claimId };
    },
    release: async (_projectId, _slot, claimId) => {
      const release = releases.get(claimId);
      releases.delete(claimId);
      await release?.();
    },
    holdsClaim: (projectId, slot, claimId) =>
      helpSessionService.holdsPendingHibernationClaim(projectId, slot, claimId),
    start: (request) => startAssistantWithoutView(request, launchDeps),
    isShuttingDown,
    isKept: (projectId, slot) => helpSessionService.isLaneKeptRunning(projectId, slot),
  });
  const globals = await globalOutcomes;
  logInfo("assistant.update-restart-resume", {
    resumed: outcomes.filter((outcome) => outcome.status === "resumed").length,
    notResumed: outcomes.flatMap((outcome) =>
      outcome.status === "resumed"
        ? []
        : [{ slot: outcome.slot, status: outcome.status, reason: outcome.reason }]
    ),
    globalResumed: globals.filter((outcome) => outcome.status === "resumed").length,
    globalNotResumed: globals.flatMap((outcome) =>
      outcome.status === "resumed"
        ? []
        : [{ slot: outcome.slot, status: outcome.status, reason: outcome.reason }]
    ),
    ...(safeMode && batch.standing.size > 0
      ? { keptLanesHeldInSafeMode: batch.standing.size }
      : {}),
  });
}
