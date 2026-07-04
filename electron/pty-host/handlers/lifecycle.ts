import { parseSpawnError } from "../index.js";
import type { AgentEvent } from "../../services/AgentStateMachine.js";
import type { SpawnResult } from "../../../shared/types/pty-host.js";
import type { HandlerMap, HostContext } from "./types.js";

/** A PTY PID is usable only once it is a positive integer. */
function isValidPid(pid: number | undefined): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

// On Windows, node-pty reports `pid: 0` during the brief window before the
// ConPTY `connect()` resolves, and never emits a follow-up event when the real
// PID lands. We poll the live PTY object across event-loop turns to recover the
// PID, capped so a terminal that never resolves can't poll forever.
const PID_RETRY_MAX_ATTEMPTS = 20;

export function createLifecycleHandlers(ctx: HostContext): HandlerMap {
  const {
    ptyManager,
    pauseCoordinators,
    resourceGovernor,
    sendEvent,
    getOrCreatePauseCoordinator,
  } = ctx;

  // Poll the live PTY object across event-loop turns for a terminal that
  // spawned with an invalid PID (Windows ConPTY). Once a positive PID lands,
  // emit `terminal-pid` and start the process detector. Stops if the terminal
  // disappears (killed/trashed) before the PID resolves, or after the cap.
  function schedulePidRetry(id: string, attempt = 0): void {
    if (attempt >= PID_RETRY_MAX_ATTEMPTS) return;
    setImmediate(() => {
      const terminalInfo = ptyManager.getTerminal(id);
      if (!terminalInfo) return; // terminal gone — abandon the retry
      const pid = terminalInfo.ptyProcess?.pid;
      if (isValidPid(pid)) {
        sendEvent({ type: "terminal-pid", id, pid });
        ptyManager.startProcessDetectorForTerminal(id);
        return;
      }
      schedulePidRetry(id, attempt + 1);
    });
  }

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
        spawnResult = {
          success: true,
          id: msg.id,
          launchGeneration: msg.options.launchGeneration,
        };

        // Eagerly create coordinator so all subsystems can pause from the start
        getOrCreatePauseCoordinator(msg.id);

        const terminalInfo = ptyManager.getTerminal(msg.id);
        const pid = terminalInfo?.ptyProcess?.pid;
        if (isValidPid(pid)) {
          sendEvent({ type: "terminal-pid", id: msg.id, pid });
        } else {
          // Windows ConPTY: retry until the real PID resolves, then emit the
          // event and start monitoring (no node-pty event fires on its own).
          schedulePidRetry(msg.id);
        }
      } catch (error) {
        console.error(`[PtyHost] Spawn failed for terminal ${msg.id}:`, error);
        spawnResult = {
          success: false,
          id: msg.id,
          launchGeneration: msg.options.launchGeneration,
          error: parseSpawnError(error),
        };

        // A failed-to-start spawn never produces a PTY, so no exit event ever
        // fires and the main-side TerminalProcess never emits agent:spawned.
        // For a launched agent that means AgentAvailabilityStore retains the
        // prior session's state and MCP waiters (waitUntilIdle) can't tell the
        // crash from an idle terminal. Synthesize the spawn + exited transition
        // so the store records "exited" and consumers see the crash (#10816).
        // Order matters: agent-spawned resets store state to "working" (and
        // clears stale exit metadata) before agent-state writes "exited".
        const launchAgentId = msg.options.launchAgentId;
        if (launchAgentId) {
          const timestamp = Date.now();
          sendEvent({
            type: "agent-spawned",
            payload: { agentId: launchAgentId, terminalId: msg.id, timestamp },
          });
          sendEvent({
            type: "agent-state",
            id: msg.id,
            agentId: launchAgentId,
            state: "exited",
            previousState: "working",
            timestamp,
            trigger: "exit",
            confidence: 1,
          });
        }
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
      if (isValidPid(killedPid)) {
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
        if (isValidPid(pid)) pids.push(pid);
      }
      const killed = ptyManager.killByProject(msg.projectId);
      for (const pid of pids) {
        resourceGovernor.trackKilledPid(pid);
      }
      sendEvent({ type: "kill-by-project-result", requestId: msg.requestId, killed });
    },

    "graceful-kill": async (msg) => {
      const killedPid = ptyManager.getTerminal(msg.id)?.ptyProcess.pid;
      const { sessionId } = await ptyManager.gracefulKill(msg.id);
      if (isValidPid(killedPid)) {
        resourceGovernor.trackKilledPid(killedPid);
      }
      sendEvent({
        type: "graceful-kill-result",
        requestId: msg.requestId,
        id: msg.id,
        agentSessionId: sessionId,
      });
    },

    "graceful-kill-by-project": async (msg) => {
      const terminalIds = ptyManager.getTerminalsForProject(msg.projectId);
      const pids: number[] = [];
      for (const id of terminalIds) {
        const pid = ptyManager.getTerminal(id)?.ptyProcess.pid;
        if (isValidPid(pid)) pids.push(pid);
      }
      const results = await ptyManager.gracefulKillByProject(msg.projectId, {
        preserveSession: msg.preserveSession,
      });
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
