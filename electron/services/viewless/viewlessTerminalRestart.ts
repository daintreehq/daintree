import { CHANNELS } from "../../ipc/channels.js";
import { LAUNCH_CONTEXT_AGENT_IDS } from "../../../shared/config/agentLaunchContext.js";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import {
  buildResumeCommand,
  dropRetiredAgentModel,
  dropUnselectedAgentModel,
  stripAssignedSessionIdArgs,
  supportsSessionIdAssignment,
} from "../../../shared/types/agentSettings.js";
import { resolveAgentLaunchBaseCommandFor } from "../../../shared/utils/agentLaunchCommand.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { mergeTerminalLaunchEnv } from "../../../shared/utils/terminalLaunchOptions.js";
import type { TerminalFirstPrompt } from "../../../shared/types/panel.js";
import type { ViewlessDeps } from "./ViewlessActionExecutor.js";

/** Why a restart with no view did not run, or that it did. */
export type ViewlessRestartOutcome =
  "restarted" | "gone" | "unsupported" | "stale" | "waiting" | "failed";

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
 * quit to its shell. So is one saved with a retired model, whose drop needs a
 * view to show it, and one holding a model a restart can't select. An input lock is a view's own preference, kept in that
 * view, so with no view there is none to honour. `beforeChange` runs once,
 * right before the first change, and only for a restart that goes ahead.
 */
export async function restartTerminalWithoutView(
  projectId: string,
  terminalId: string,
  deps: ViewlessDeps,
  isCurrent: () => boolean = () => true,
  beforeChange: () => void = () => {}
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
  // A saved retired model fails the relaunch (#15652), and a view's restart
  // drops it with a notice saying so. With no view, nobody would see the drop,
  // so the pane keeps running until one restarts it.
  if (dropRetiredAgentModel(agentId, snapshot).droppedModelIds.length > 0) return "unsupported";
  // So does a model a restart can't select (#15569): a view's restart takes it
  // out of the launch, the record and the title together, which this host's
  // session-only update can't.
  if (dropUnselectedAgentModel(agentId, snapshot, { replay: true }) !== snapshot) {
    return "unsupported";
  }

  // The reads above wait on the pty-host and the disk; the terminal may have
  // been relaunched meanwhile, and its successor isn't the one that leaked.
  if (!isCurrent()) return "stale";
  beforeChange();

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
  let sessionId: string | undefined;
  let resumedSessionId: string | undefined;
  if (agentId !== undefined) {
    // The graceful shutdown quits whichever agent is live, so its capture only
    // names this pane's conversation while the detected agent is the launched one.
    const captureTrusted = info.detectedAgentId === undefined || info.detectedAgentId === agentId;
    sessionId = (captureTrusted ? capturedSessionId : null) ?? snapshot.agentSessionId;
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
  // The first prompt stays with the run it was handed to (#14592), as a view's
  // restart keeps it: a resume goes on with that run, including a record it
  // took while being stopped, and a start-over replays the stored command,
  // which carries a launch prompt but never a sent one.
  const startsOver = resumedSessionId === undefined;
  const keepsFirstPrompt = startsOver
    ? snapshot.firstPrompt?.via === "launch"
    : (await savedFirstPrompt(deps, projectId, terminalId)) !== undefined;

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

  // The kill and the launch reads above wait too: a relaunch meanwhile already
  // runs under this id, and a quit has its own sweep, so neither gets a respawn.
  if (!isCurrent()) return "stale";

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
              ...(keepsFirstPrompt ? { hasFirstPrompt: true } : {}),
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
    // The agent has quit and nothing replaced it: the pane's next restore
    // resumes the conversation the quit captured, as a view's failed restart
    // keeps it for a retry.
    if (sessionId !== undefined) {
      await recordAgentSession(deps, projectId, terminalId, sessionId);
    }
    return "failed";
  }

  if (agentId !== undefined) {
    // What the pane's next restore resumes, as a view's restart leaves it: the
    // conversation just resumed for an agent whose id Daintree assigns, and
    // otherwise nothing until the next teardown captures one.
    const nextSessionId = supportsSessionIdAssignment(agentId) ? resumedSessionId : undefined;
    await recordAgentSession(deps, projectId, terminalId, nextSessionId, startsOver);
  }
  return "restarted";
}

/** The pane's saved first prompt, read behind every write already queued. */
async function savedFirstPrompt(
  deps: ViewlessDeps,
  projectId: string,
  terminalId: string
): Promise<TerminalFirstPrompt | undefined> {
  let firstPrompt: TerminalFirstPrompt | undefined;
  await deps.stateWriter
    .enqueueProjectStateUpdate(projectId, (existing) => {
      firstPrompt = existing?.terminals.find((t) => t.id === terminalId)?.firstPrompt;
      return null;
    })
    .catch(() => undefined);
  return firstPrompt;
}

/**
 * `startedOver` drops a sent first prompt from the saved pane, read when the
 * write runs: one the old run took while it was being stopped is its record,
 * never the new conversation's.
 */
async function recordAgentSession(
  deps: ViewlessDeps,
  projectId: string,
  terminalId: string,
  agentSessionId: string | undefined,
  startedOver = false
): Promise<void> {
  await deps.stateWriter
    .enqueueProjectStateUpdate(projectId, (existing) =>
      existing
        ? {
            ...existing,
            terminals: existing.terminals.map((terminal) => {
              if (terminal.id !== terminalId) return terminal;
              if (!startedOver || terminal.firstPrompt?.via !== "send") {
                return { ...terminal, agentSessionId };
              }
              const { firstPrompt: _dropped, ...rest } = terminal;
              return { ...rest, agentSessionId };
            }),
          }
        : existing
    )
    .catch((err: unknown) => {
      console.warn(
        `[MemoryLeak] Couldn't record terminal ${terminalId.slice(0, 8)}'s session:`,
        formatErrorMessage(err, "unknown")
      );
    });
}
