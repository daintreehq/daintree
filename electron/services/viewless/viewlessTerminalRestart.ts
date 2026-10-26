import { CHANNELS } from "../../ipc/channels.js";
import {
  buildResumeCommand,
  stripAssignedSessionIdArgs,
  supportsSessionIdAssignment,
} from "../../../shared/types/agentSettings.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { mergeTerminalLaunchEnv } from "../../../shared/utils/terminalLaunchOptions.js";
import type { ViewlessDeps } from "./ViewlessActionExecutor.js";

/** Why a restart with no view did not run, or that it did. */
export type ViewlessRestartOutcome =
  | "restarted"
  | "gone"
  | "unsupported"
  | "waiting"
  | "input-locked"
  | "failed";

/**
 * Restart one terminal of a project no frontend is attached to (#14703): the
 * host's memory-leak policy, which has no view to hand the restart to.
 *
 * It does what a view's restart does with the panel it would hydrate: quit the
 * agent through the graceful kill (which captures its session and journals the
 * close), then relaunch the same id through the same spawn handler, resuming
 * the captured conversation when the agent can, and starting it fresh with the
 * saved launch otherwise. A pane the view would refuse to restart is left as it
 * is: one waiting for input, one locked against input, one held for recovery,
 * and an agent that already quit to its shell.
 */
export async function restartTerminalWithoutView(
  projectId: string,
  terminalId: string,
  deps: ViewlessDeps
): Promise<ViewlessRestartOutcome> {
  const pty = deps.getPtyReader();
  if (!pty) return "gone";
  const [state, info] = await Promise.all([
    deps.getProjectState(projectId).catch(() => null),
    pty.getTerminalAsync(terminalId).catch(() => null),
  ]);
  const snapshot = state?.terminals.find((terminal) => terminal.id === terminalId);
  if (!snapshot || !info || info.isExited === true || info.isTrashed === true) return "gone";
  if ((snapshot.kind ?? "terminal") !== "terminal" || snapshot.restoreRecovery) {
    return "unsupported";
  }
  if (info.agentState === "waiting") return "waiting";
  if (Reflect.get(snapshot, "isInputLocked") === true) return "input-locked";

  const agentId = snapshot.launchAgentId;
  // A demoted pane runs the shell its agent quit to; a view restarts it as that
  // shell, which takes launch state this host never kept for it.
  if (agentId !== undefined && info.agentState === "exited") return "unsupported";

  let capturedSessionId: string | null = null;
  try {
    if (agentId !== undefined) {
      capturedSessionId = await deps.invoke<string | null>(
        projectId,
        CHANNELS.TERMINAL_GRACEFUL_KILL,
        [terminalId, { forRestart: true }]
      );
    } else {
      await deps.invoke(projectId, CHANNELS.TERMINAL_KILL, [terminalId, { forRestart: true }]);
    }
  } catch (err) {
    console.warn(
      `[MemoryLeak] Couldn't stop terminal ${terminalId.slice(0, 8)} to restart it:`,
      formatErrorMessage(err, "unknown")
    );
    return "failed";
  }

  let command = snapshot.command;
  let resumedSessionId: string | undefined;
  if (agentId !== undefined) {
    // The graceful shutdown quits whichever agent is live, so its capture only
    // names this pane's conversation while the detected agent is the launched one.
    const captureTrusted = info.detectedAgentId === undefined || info.detectedAgentId === agentId;
    const sessionId = (captureTrusted ? capturedSessionId : null) ?? snapshot.agentSessionId;
    const resume = sessionId
      ? buildResumeCommand(agentId, sessionId, snapshot.agentLaunchFlags)
      : undefined;
    if (resume && sessionId) {
      command = resume;
      resumedSessionId = sessionId;
    } else if (command) {
      command = stripAssignedSessionIdArgs(command, agentId);
    }
  }

  const layers = await deps.getLaunchEnvLayers(projectId).catch(() => null);
  const env = mergeTerminalLaunchEnv(layers?.global, layers?.project, snapshot.env);
  const size = state?.terminalSizes?.[terminalId];

  try {
    await deps.invoke<string>(projectId, CHANNELS.TERMINAL_SPAWN, [
      {
        id: terminalId,
        kind: "terminal",
        projectId,
        cwd: snapshot.cwd ?? info.cwd ?? undefined,
        cols: size?.cols ?? 80,
        rows: size?.rows ?? 24,
        title: snapshot.title,
        ...(snapshot.titleMode !== undefined ? { titleMode: snapshot.titleMode } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(snapshot.worktreeId !== undefined ? { worktreeId: snapshot.worktreeId } : {}),
        ...(agentId !== undefined
          ? {
              launchAgentId: agentId,
              agentLaunchFlags: snapshot.agentLaunchFlags,
              agentModelId: snapshot.agentModelId,
              agentSessionId:
                resumedSessionId !== undefined && supportsSessionIdAssignment(agentId)
                  ? resumedSessionId
                  : undefined,
              agentPresetId: snapshot.agentPresetId,
              agentPresetColor: snapshot.agentPresetColor,
              originalAgentPresetId: snapshot.originalPresetId,
            }
          : {}),
      },
    ]);
  } catch (err) {
    console.warn(
      `[MemoryLeak] Couldn't relaunch terminal ${terminalId.slice(0, 8)} after stopping it:`,
      formatErrorMessage(err, "unknown")
    );
    return "failed";
  }
  return "restarted";
}
