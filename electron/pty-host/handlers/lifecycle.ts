import { parseSpawnError } from "../index.js";
import type { AgentEvent } from "../../services/AgentStateMachine.js";
import type { SpawnResult } from "../../../shared/types/pty-host.js";
import type { HandlerMap, HostContext } from "./types.js";

export function createLifecycleHandlers(ctx: HostContext): HandlerMap {
  const {
    ptyManager,
    pauseCoordinators,
    resourceGovernor,
    sendEvent,
    getOrCreatePauseCoordinator,
  } = ctx;

  return {
    spawn: (msg) => {
      let spawnResult: SpawnResult;
      try {
        // Remove stale coordinator before spawn (handles ID respawn)
        const staleCoord = pauseCoordinators.get(msg.id);
        if (staleCoord) {
          staleCoord.forceReleaseAll();
          pauseCoordinators.delete(msg.id);
        }

        ptyManager.spawn(msg.id, msg.options);
        spawnResult = { success: true, id: msg.id };

        // Eagerly create coordinator so all subsystems can pause from the start
        getOrCreatePauseCoordinator(msg.id);

        const terminalInfo = ptyManager.getTerminal(msg.id);
        const pid = terminalInfo?.ptyProcess?.pid;
        if (pid !== undefined) {
          sendEvent({ type: "terminal-pid", id: msg.id, pid });
        }
      } catch (error) {
        console.error(`[PtyHost] Spawn failed for terminal ${msg.id}:`, error);
        spawnResult = {
          success: false,
          id: msg.id,
          error: parseSpawnError(error),
        };
      }

      sendEvent({ type: "spawn-result", id: msg.id, result: spawnResult });
    },

    kill: (msg) => {
      const termInfo = ptyManager.getTerminal(msg.id);
      const killedPid = termInfo?.ptyProcess.pid;
      if (msg.escalationDelayMs !== undefined) {
        ptyManager.kill(msg.id, msg.reason, { escalationDelayMs: msg.escalationDelayMs });
      } else {
        ptyManager.kill(msg.id, msg.reason);
      }
      if (killedPid !== undefined) {
        resourceGovernor.trackKilledPid(killedPid);
      }
    },

    trash: (msg) => {
      ptyManager.trash(msg.id);
    },

    restore: (msg) => {
      ptyManager.restore(msg.id);
    },

    "kill-by-project": (msg) => {
      const terminalIds = ptyManager.getTerminalsForProject(msg.projectId);
      const pids: number[] = [];
      for (const id of terminalIds) {
        const pid = ptyManager.getTerminal(id)?.ptyProcess.pid;
        if (pid !== undefined) pids.push(pid);
      }
      const killed = ptyManager.killByProject(msg.projectId);
      for (const pid of pids) {
        resourceGovernor.trackKilledPid(pid);
      }
      sendEvent({ type: "kill-by-project-result", requestId: msg.requestId, killed });
    },

    "graceful-kill": async (msg) => {
      const killedPid = ptyManager.getTerminal(msg.id)?.ptyProcess.pid;
      const agentSessionId = await ptyManager.gracefulKill(msg.id);
      if (killedPid !== undefined) {
        resourceGovernor.trackKilledPid(killedPid);
      }
      sendEvent({
        type: "graceful-kill-result",
        requestId: msg.requestId,
        id: msg.id,
        agentSessionId,
      });
    },

    "graceful-kill-by-project": async (msg) => {
      const terminalIds = ptyManager.getTerminalsForProject(msg.projectId);
      const pids: number[] = [];
      for (const id of terminalIds) {
        const pid = ptyManager.getTerminal(id)?.ptyProcess.pid;
        if (pid !== undefined) pids.push(pid);
      }
      const results = await ptyManager.gracefulKillByProject(msg.projectId);
      for (const pid of pids) {
        resourceGovernor.trackKilledPid(pid);
      }
      sendEvent({
        type: "graceful-kill-by-project-result",
        requestId: msg.requestId,
        results,
      });
    },

    "mark-checked": (msg) => {
      ptyManager.markChecked(msg.id);
    },

    "update-observed-title": (msg) => {
      ptyManager.updateObservedTitle(msg.id, msg.title);
    },

    "transition-state": (msg) => {
      const success = ptyManager.transitionState(
        msg.id,
        msg.event as AgentEvent,
        msg.trigger as
          | "input"
          | "output"
          | "heuristic"
          | "ai-classification"
          | "timeout"
          | "exit"
          | "title",
        msg.confidence,
        msg.spawnedAt
      );
      sendEvent({ type: "transition-result", id: msg.id, requestId: msg.requestId, success });
    },
  };
}
