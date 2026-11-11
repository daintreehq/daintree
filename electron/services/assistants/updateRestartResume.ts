import { projectIdFromSlotKey, slotFromSlotKey } from "../../../shared/config/assistantSlots.js";
import type { LaunchResume } from "../PendingHelpHibernationStore.js";
import type { AssistantLaunchRequest, AssistantLaunchResult } from "./assistantLaunch.js";

// Each start is a billed CLI and a spawn competing with the panes the launch
// restores; all at once would queue behind the spawn limiter anyway.
const CONCURRENT_RESUMES = 3;

export interface UpdateRestartResumeDeps {
  /**
   * Claims the lane's pointer the way a view's resume does, so no view resumes
   * the same conversation alongside it, and has a view's own automatic launch
   * stand down until the lane is back. Null when the lane has none or a view
   * holds it.
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
}

export type UpdateRestartLaneOutcome =
  | { projectId: string; slot: number; status: "resumed" }
  | {
      projectId: string;
      slot: number;
      status: "skipped";
      reason: "shutting-down" | "unclaimed" | "moved-on";
    }
  | { projectId: string; slot: number; status: "refused"; reason: string };

interface RecordedLane {
  projectId: string;
  slot: number;
  agentSessionId: string;
}

/**
 * Resumes the Assistant lanes a restart to install an update stopped (#16753),
 * each into the conversation it was running, with no view, as a schedule's
 * Assistant starts: the first view of its project takes it over. A lane whose
 * pointer has moved on, whose agent can't start that way, or whose
 * conversation can't be reopened stays down with its pointer kept, to be
 * resumed by hand as after any other restart; nothing starts fresh in its place.
 */
export async function resumeLanesAfterUpdate(
  record: LaunchResume,
  deps: UpdateRestartResumeDeps
): Promise<UpdateRestartLaneOutcome[]> {
  const lanes: RecordedLane[] = Object.entries(record.lanes).flatMap(
    ([slotKey, agentSessionId]) => {
      const projectId = projectIdFromSlotKey(slotKey);
      const slot = slotFromSlotKey(slotKey);
      return projectId && slot !== null ? [{ projectId, slot, agentSessionId }] : [];
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
        startedBy: { kind: "update-restart" },
        resume: { agentSessionId: claim.agentSessionId, cwd: claim.cwd },
        stillWanted: () =>
          !deps.isShuttingDown() && deps.holdsClaim(projectId, slot, claim.claimId),
      })
      .catch((): AssistantLaunchResult => ({ status: "refused", reason: "launch-failed" }));
    return result.status === "started"
      ? { projectId, slot, status: "resumed" }
      : { projectId, slot, status: "refused", reason: result.reason };
  } finally {
    await deps.release(projectId, slot, claim.claimId).catch(() => {});
  }
}

/** `resumeLanesAfterUpdate` with the app's own services, loaded only when there is something to resume. */
export async function resumeLanesAfterUpdateLive(record: LaunchResume): Promise<void> {
  const [
    { helpSessionService },
    { startAssistantWithoutView, liveAssistantLaunchDeps },
    { getActiveShutdown },
    { logInfo },
  ] = await Promise.all([
    import("../HelpSessionService.js"),
    import("./assistantLaunch.js"),
    import("../../lifecycle/shutdownCoordinator.js"),
    import("../../utils/logger.js"),
  ]);
  const launchDeps = await liveAssistantLaunchDeps();
  const resuming = new Map<string, () => void>();
  const outcomes = await resumeLanesAfterUpdate(record, {
    claim: async (projectId, slot) => {
      const claim = await helpSessionService.takePendingHibernation(projectId, slot);
      if (claim) resuming.set(claim.claimId, helpSessionService.beginLaneResume(projectId, slot));
      return claim;
    },
    release: async (projectId, slot, claimId) => {
      resuming.get(claimId)?.();
      resuming.delete(claimId);
      await helpSessionService.restorePendingHibernation(projectId, slot, claimId);
    },
    holdsClaim: (projectId, slot, claimId) =>
      helpSessionService.holdsPendingHibernationClaim(projectId, slot, claimId),
    start: (request) => startAssistantWithoutView(request, launchDeps),
    isShuttingDown: () => getActiveShutdown() !== null,
  });
  logInfo("assistant.update-restart-resume", {
    resumed: outcomes.filter((outcome) => outcome.status === "resumed").length,
    notResumed: outcomes.flatMap((outcome) =>
      outcome.status === "resumed"
        ? []
        : [{ slot: outcome.slot, status: outcome.status, reason: outcome.reason }]
    ),
  });
}
