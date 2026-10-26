import { CHANNELS } from "../../ipc/channels.js";
import { LAUNCH_CONTEXT_AGENT_IDS } from "../../../shared/config/agentLaunchContext.js";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import {
  buildResumeCommand,
  stripAssignedSessionIdArgs,
  supportsSessionIdAssignment,
} from "../../../shared/types/agentSettings.js";
import { resolveAgentLaunchBaseCommandFor } from "../../../shared/utils/agentLaunchCommand.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { mergeTerminalLaunchEnv } from "../../../shared/utils/terminalLaunchOptions.js";
import type { ViewlessDeps } from "./ViewlessActionExecutor.js";

/** Why a restart with no view did not run, or that it did. */
export type ViewlessRestartOutcome =
  "restarted" | "gone" | "unsupported" | "waiting" | "input-locked" | "failed";

/**
 * Restart one terminal of a project no frontend is attached to (#14703): the
 * host's memory-leak policy, which has no view to hand the restart to.
 *
 * It does what a view's restart does with the panel it would hydrate: quit the
 * agent through the graceful kill (which captures its session and journals the
 * close), then relaunch the same id through the same spawn handler, resuming
 * the captured conversation when the agent can, and starting it fresh with the
 * saved launch otherwise. A pane the view would refuse to restart is left as it
 * is: one waiting for input, one held for recovery, and an agent that already
 * quit to its shell. An input lock is a view's own preference, kept in that
 * view, so with no view there is none to honour.
 */
export async function restartTerminalWithoutView(
  projectId: string,
  terminalId: string,
  deps: ViewlessDeps,
  isCurrent: () => boolean = () => true
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

  const agentId = snapshot.launchAgentId;
  // A demoted pane runs the shell its agent quit to; a view restarts it as that
  // shell, which takes launch state this host never kept for it.
  if (agentId !== undefined && info.agentState === "exited") return "unsupported";

  // The reads above wait on the pty-host and the disk; the terminal may have
  // been relaunched meanwhile, and its successor isn't the one that leaked.
  if (!isCurrent()) return "stale";

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
    // The executable this host finds for the agent, so one outside the shell's
    // PATH resumes as it launched.
    const registryCommand = getEffectiveAgentConfig(agentId)?.command;
    const baseCommand =
      sessionId && registryCommand !== undefined
        ? resolveAgentLaunchBaseCommandFor(
            registryCommand,
            await deps.agents.getCliDetail(agentId).catch(() => undefined),
            deps.hostPlatform.shellDialect,
            undefined
          )
        : undefined;
    const resume = sessionId
      ? buildResumeCommand(agentId, sessionId, snapshot.agentLaunchFlags, baseCommand)
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
  // The launch-time context an agent pane's MCP session replays (#12486),
  // pointed at the pane itself, as a view's restart captures it.
  const actionContext =
    agentId !== undefined && LAUNCH_CONTEXT_AGENT_IDS.has(agentId)
      ? {
          projectId,
          ...(snapshot.worktreeId !== undefined
            ? { activeWorktreeId: snapshot.worktreeId, focusedWorktreeId: snapshot.worktreeId }
            : {}),
          focusedTerminalId: terminalId,
          focusedTerminalKind: "terminal" as const,
          focusedTerminalTitle: snapshot.title,
        }
      : undefined;

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
        ...(actionContext !== undefined ? { actionContext } : {}),
      },
    ]);
  } catch (err) {
    console.warn(
      `[MemoryLeak] Couldn't relaunch terminal ${terminalId.slice(0, 8)} after stopping it:`,
      formatErrorMessage(err, "unknown")
    );
    return "failed";
  }

  if (agentId !== undefined) {
    // What the pane's next restore resumes, as a view's restart leaves it: the
    // conversation just resumed for an agent whose id Daintree assigns, and
    // otherwise nothing until the next teardown captures one.
    const nextSessionId = supportsSessionIdAssignment(agentId) ? resumedSessionId : undefined;
    await deps.stateWriter
      .enqueueProjectStateUpdate(projectId, (existing) =>
        existing
          ? {
              ...existing,
              terminals: existing.terminals.map((terminal) =>
                terminal.id === terminalId
                  ? { ...terminal, agentSessionId: nextSessionId }
                  : terminal
              ),
            }
          : existing
      )
      .catch((err: unknown) => {
        console.warn(
          `[MemoryLeak] Couldn't record terminal ${terminalId.slice(0, 8)}'s session after restarting it:`,
          formatErrorMessage(err, "unknown")
        );
      });
  }
  return "restarted";
}
