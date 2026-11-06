import { CHANNELS } from "../../ipc/channels.js";
import { getActiveShutdown } from "../../lifecycle/shutdownCoordinator.js";
import { events } from "../events.js";
import { projectStore } from "../ProjectStore.js";
import {
  closeTerminalKeepingSession,
  sendToLocalProjectViews,
} from "../pty/terminalDoneOperations.js";
import {
  backgroundViewlessTerminal,
  forgetViewlessTerminal,
} from "../viewless/projectStateAuthoring.js";
import type { ScheduledRunFinishRequest } from "../../../shared/types/ipc/schedules.js";
import type { ScheduledRun } from "../../../shared/types/scheduledRuns.js";
import { peekScheduledRunRecorder } from "./index.js";
import {
  ScheduledRunDonePolicy,
  type ArmedScheduledRun,
  type ScheduledRunDoneAction,
} from "./ScheduledRunDonePolicy.js";

/**
 * Asks every local view of the project to apply the policy to its pane. A
 * view acts only on a pane it holds; one that opened while main was launching
 * the run may hold none, so the saved layout is written as well.
 */
function askViews(target: ArmedScheduledRun, action: ScheduledRunFinishRequest["action"]): void {
  const request: ScheduledRunFinishRequest = {
    runId: target.runId,
    terminalId: target.terminalId,
    action,
  };
  sendToLocalProjectViews(target.projectId, CHANNELS.SCHEDULES_FINISH_REQUEST, request);
}

/**
 * Closes the run's terminal the way a quit does, recorded on the run through
 * the captured session. False when the run's own incarnation is no longer the
 * one running under its id.
 */
function closeRunTerminal(target: ArmedScheduledRun, run: ScheduledRun): Promise<boolean> {
  const { terminalSpawnedAt } = run;
  return closeTerminalKeepingSession(
    { terminalId: target.terminalId, spawnedAt: terminalSpawnedAt },
    "scheduled-run-done",
    undefined,
    // An Assistant's run keeps its conversation (#16169): a Codex Assistant's id is only known now.
    (capture) => {
      if (terminalSpawnedAt === null) return;
      peekScheduledRunRecorder()?.handleSessionCaptured({
        record: { ...capture, terminal: { id: target.terminalId, spawnedAt: terminalSpawnedAt } },
      });
    }
  );
}

async function applyDonePolicy(
  target: ArmedScheduledRun,
  action: ScheduledRunDoneAction,
  run: ScheduledRun
): Promise<void> {
  // An Assistant (#16169) runs in its own tab, never the grid or the saved
  // layout: closing it is its own terminal ending, which its views and its
  // session follow, and the workers it launched are left running.
  if (run.assistant === true) {
    if (action === "close") await closeRunTerminal(target, run);
    return;
  }
  // The saved layout is written whether or not a view holds the pane: a view
  // that does saves the same placement from its own store.
  if (action === "background") {
    askViews(target, "background");
    await backgroundViewlessTerminal(projectStore, target.projectId, target.terminalId);
    return;
  }
  if (!(await closeRunTerminal(target, run))) return;
  askViews(target, "remove");
  await forgetViewlessTerminal(projectStore, target.projectId, target.terminalId);
}

let policy: { readonly policy: ScheduledRunDonePolicy; readonly stop: () => void } | null = null;

/**
 * Arms a launched run's done policy (#15982), from the launcher once the
 * launch has finished. Listens for runs ending for the life of the process.
 */
export function armScheduledRunDonePolicy(target: ArmedScheduledRun): void {
  const recorder = peekScheduledRunRecorder();
  if (!recorder) return;
  if (!policy) {
    const created = new ScheduledRunDonePolicy({
      getRun: (runId) => recorder.get(runId),
      isShuttingDown: () => getActiveShutdown() !== null,
      apply: applyDonePolicy,
    });
    const offEnded = events.on("scheduled-run:ended", (payload) => created.handleRunEnded(payload));
    const offDeleted = events.on("scheduled-runs:deleted", (payload) =>
      created.handleRunsDeleted(payload)
    );
    policy = {
      policy: created,
      stop: () => {
        offEnded();
        offDeleted();
      },
    };
  }
  policy.policy.arm(target);
}

/** @internal Tests only. */
export function _resetScheduledRunDonePolicyForTest(): void {
  policy?.stop();
  policy = null;
}
