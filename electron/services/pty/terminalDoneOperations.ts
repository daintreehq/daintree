import type { ChannelName } from "../../ipc/channels.js";
import { thawThenSend } from "../../utils/thawThenSend.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { getWebContentsForProject } from "../../window/webContentsRegistry.js";
import { events } from "../events.js";
import { attributeClose } from "./closeAttribution.js";
import { getLifecycleLedger } from "./lifecycleLedger.js";
import { scheduledRunForRecord } from "../../../shared/utils/scheduledRunProvenance.js";

/**
 * Sends `payload` to every local view of the project, thawing a cached one
 * first: a frozen renderer runs nothing. A view torn down mid-send has no pane
 * left to move.
 */
export function sendToLocalProjectViews(
  projectId: string,
  channel: ChannelName,
  payload: unknown
): void {
  for (const view of getWebContentsForProject(projectId)) {
    thawThenSend(
      view,
      () => true,
      () => {
        try {
          view.send(channel, payload);
        } catch {
          // A view torn down mid-send has no pane left to move.
        }
      }
    );
  }
}

/** The incarnation a close is for: the host's answer must name its `spawnedAt`. */
export interface KeepingSessionTarget {
  readonly terminalId: string;
  readonly spawnedAt: number | null;
}

/**
 * Closes a terminal the way a quit does (#15982, #16171): a graceful kill that
 * asks the agent to leave and captures its session id, journaled for resuming,
 * never the trash a view's close puts it in. False when `target`'s incarnation
 * is no longer the one running under its id, or a restart was asked for while
 * the agent was leaving.
 */
export async function closeTerminalKeepingSession(
  target: KeepingSessionTarget,
  killReason: string
): Promise<boolean> {
  const ptyClient = getPtyClient();
  if (!ptyClient) return false;
  const info = await ptyClient.getTerminalAsync(target.terminalId).catch(() => null);
  if (!info || target.spawnedAt === null || info.spawnedAt !== target.spawnedAt) {
    return false;
  }
  // Every spawn mints its generation here in main, so a restart asked for
  // while the host answered shows as a newer one. Checked with no await before
  // the kill is sent, which then reaches the host ahead of any later spawn.
  const launchGeneration = getLifecycleLedger().currentGeneration(target.terminalId);
  if (
    info.launchGeneration !== undefined &&
    launchGeneration !== undefined &&
    info.launchGeneration !== launchGeneration
  ) {
    return false;
  }
  const sessionId = await ptyClient.gracefulKill(target.terminalId);
  // A restart asked for while the agent was leaving is the user's: its
  // terminal and pane stay. Checked again with no await before acting.
  const restarted = getLifecycleLedger().currentGeneration(target.terminalId) !== launchGeneration;
  // A terminal whose agent had already exited isn't killed by a graceful close.
  if (info.isExited === true && !restarted) {
    ptyClient.kill(target.terminalId, killReason);
  }
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
  return !restarted;
}
