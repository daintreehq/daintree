import { CHANNELS } from "../../ipc/channels.js";
import { getActiveShutdown } from "../../lifecycle/shutdownCoordinator.js";
import { thawThenSend } from "../../utils/thawThenSend.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { getWebContentsForProject } from "../../window/webContentsRegistry.js";
import { events } from "../events.js";
import { projectStore } from "../ProjectStore.js";
import { attributeClose } from "../pty/closeAttribution.js";
import { getLifecycleLedger } from "../pty/lifecycleLedger.js";
import {
  backgroundViewlessTerminal,
  forgetViewlessTerminal,
} from "../viewless/projectStateAuthoring.js";
import type { ScheduledRunFinishRequest } from "../../../shared/types/ipc/schedules.js";
import type { ScheduledRun } from "../../../shared/types/scheduledRuns.js";
import { scheduledRunForRecord } from "../../../shared/utils/scheduledRunProvenance.js";
import { peekScheduledRunRecorder } from "./index.js";
import {
  ScheduledRunDonePolicy,
  type ArmedScheduledRun,
  type ScheduledRunDoneAction,
} from "./ScheduledRunDonePolicy.js";

/**
 * Asks every local view of the project to apply the policy to its pane. A view
 * holding the pane owns its place in the saved layout, so Main doesn't write
 * it; false when no view shows the project.
 */
function askViews(target: ArmedScheduledRun, action: ScheduledRunFinishRequest["action"]): boolean {
  const views = getWebContentsForProject(target.projectId);
  const request: ScheduledRunFinishRequest = {
    runId: target.runId,
    terminalId: target.terminalId,
    action,
  };
  for (const view of views) {
    // A cached view may be frozen, and a frozen renderer runs nothing.
    thawThenSend(
      view,
      () => true,
      () => {
        try {
          view.send(CHANNELS.SCHEDULES_FINISH_REQUEST, request);
        } catch {
          // A view torn down mid-send has no pane left to move.
        }
      }
    );
  }
  return views.length > 0;
}

/**
 * Closes the run's terminal the way a quit does: a graceful kill that asks the
 * agent to leave and captures its session id, journaled and recorded on the
 * run, never the trash a view's close puts it in. False when the run's own
 * incarnation is no longer the one running under its id.
 */
async function closeRunTerminal(target: ArmedScheduledRun, run: ScheduledRun): Promise<boolean> {
  const ptyClient = getPtyClient();
  if (!ptyClient) return false;
  const info = await ptyClient.getTerminalAsync(target.terminalId).catch(() => null);
  if (!info || run.terminalSpawnedAt === null || info.spawnedAt !== run.terminalSpawnedAt) {
    return false;
  }
  // The generation before the kill: a respawn under the same id must not take the record.
  const launchGeneration = getLifecycleLedger().currentGeneration(target.terminalId);
  const sessionId = await ptyClient.gracefulKill(target.terminalId);
  // A terminal whose agent had already exited isn't killed by a graceful close.
  if (info.isExited === true) ptyClient.kill(target.terminalId, "scheduled-run-done");
  if (sessionId && info.launchAgentId && info.isAssistantTerminal !== true) {
    events.emit("agent-session:captured", {
      terminalId: target.terminalId,
      launchGeneration,
      boundary: "kill",
      record: {
        sessionId,
        agentId: info.launchAgentId,
        worktreeId: info.worktreeId ?? null,
        title:
          (info.titleMode === "user" ? info.title : (info.lastObservedTitle ?? info.title)) ?? null,
        projectId: info.projectId ?? null,
        agentLaunchFlags: info.agentLaunchFlags,
        agentModelId: info.agentModelId,
        cwd: info.cwd,
        ...scheduledRunForRecord(info),
        ...attributeClose(info, "kill"),
      },
    });
  }
  return true;
}

async function applyDonePolicy(
  target: ArmedScheduledRun,
  action: ScheduledRunDoneAction,
  run: ScheduledRun
): Promise<void> {
  if (action === "background") {
    if (askViews(target, "background")) return;
    await backgroundViewlessTerminal(projectStore, target.projectId, target.terminalId);
    return;
  }
  if (!(await closeRunTerminal(target, run))) return;
  if (askViews(target, "remove")) return;
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
