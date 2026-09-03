/**
 * Terminal event handlers - forwards events to renderer.
 */

import { CHANNELS } from "../../channels.js";
import { broadcastToProjectRenderers, broadcastToRenderer } from "../../utils.js";
import { events, type DaintreeEventMap } from "../../../services/events.js";
import { mcpPaneConfigService } from "../../../services/McpPaneConfigService.js";
import { journalAgentSession } from "../../../services/pty/agentSessionJournal.js";
import type {
  SpawnResult,
  TerminalResizeResult,
  BroadcastWriteResultPayload,
  FdLeakWarningPayload,
  TerminalSubmitStatusPayload,
} from "../../../../shared/types/pty-host.js";
import type { HandlerDependencies } from "../../types.js";

export function registerTerminalEventHandlers(deps: HandlerDependencies): () => void {
  const { ptyClient } = deps;
  if (!ptyClient) {
    return () => {};
  }
  const handlers: Array<() => void> = [];

  // PTY data/exit/error events. `terminal:data` stays on its dedicated channel
  // (high-frequency binary — keeping it off the event bus avoids envelope overhead
  // and JSON/base64 churn; see lessons #4899/#4862/#4639).
  const handlePtyData = (id: string, data: string | Uint8Array) => {
    broadcastToRenderer(CHANNELS.TERMINAL_DATA, id, data);
  };
  ptyClient.on("data", handlePtyData);
  handlers.push(() => ptyClient.off("data", handlePtyData));

  const handlePtyExit = (id: string, exitCode: number) => {
    // Best-effort: revoke any per-pane MCP token + delete the managed config
    // file. Idempotent — no-ops if no pane config was minted for this terminal.
    mcpPaneConfigService.revokePaneConfig(id).catch((err) => {
      console.error("[MCP] Failed to revoke pane config on exit:", err);
    });
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "terminal:exit",
      payload: [id, exitCode],
    });
  };
  ptyClient.on("exit", handlePtyExit);
  handlers.push(() => ptyClient.off("exit", handlePtyExit));

  const handlePtyError = (id: string, error: string) => {
    broadcastToRenderer(CHANNELS.TERMINAL_ERROR, id, error);
  };
  ptyClient.on("error", handlePtyError);
  handlers.push(() => ptyClient.off("error", handlePtyError));

  // Submit-lane status (#11875). Project-scoped for the same reason as
  // `terminal:status` below: only views of the owning project host a panel for
  // this terminal, so don't pay a clone + IPC task per unrelated view.
  const handleSubmitStatus = (payload: TerminalSubmitStatusPayload) => {
    broadcastToProjectRenderers(ptyClient.getTerminalProjectId(payload.id), CHANNELS.EVENTS_PUSH, {
      name: "terminal:submit-status",
      payload,
    });
  };
  ptyClient.on("submit-status", handleSubmitStatus);
  handlers.push(() => ptyClient.off("submit-status", handleSubmitStatus));

  // Spawn result events (success or failure)
  const handleSpawnResult = (id: string, result: SpawnResult) => {
    if (!result.success) {
      // Async pty-host spawn rejection (PENDING_SPAWNS_CAPPED, bad shell path,
      // etc.) doesn't throw from ptyClient.spawn(). Revoke any minted pane
      // config so the token doesn't outlive the never-running PTY.
      mcpPaneConfigService.revokePaneConfig(id).catch((err) => {
        console.error("[MCP] Failed to revoke pane config on spawn failure:", err);
      });
    }
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "terminal:spawn-result",
      payload: [id, result],
    });
  };
  ptyClient.on("spawn-result", handleSpawnResult);
  handlers.push(() => ptyClient.off("spawn-result", handleSpawnResult));

  // Geometry the PTY actually holds after a resize. The renderer compares it
  // against its own xterm grid to detect a split the two sides cannot otherwise
  // see (#11641). Already generation-filtered by the router. Project-scoped for
  // the same reason as `terminal:status` below — only views of the owning
  // project host panels for the terminal, and every other view drops the echo
  // in `recordPtyResizeResult` after paying for the clone.
  const handleResizeResult = (id: string, result: TerminalResizeResult) => {
    broadcastToProjectRenderers(ptyClient.getTerminalProjectId(id), CHANNELS.EVENTS_PUSH, {
      name: "terminal:resize-result",
      payload: [id, result],
    });
  };
  ptyClient.on("resize-result", handleResizeResult);
  handlers.push(() => ptyClient.off("resize-result", handleResizeResult));

  // Terminal status for flow control visibility. Per-terminal pulses are
  // inherently project-scoped — only views of the owning project host panels
  // for the terminal, so don't pay a clone + IPC task per unrelated view.
  const handleTerminalStatus = (payload: {
    id: string;
    status: string;
    bufferUtilization?: number;
    pauseDuration?: number;
    droppedBytes?: number;
    timestamp: number;
  }) => {
    broadcastToProjectRenderers(
      ptyClient.getTerminalProjectId(payload.id),
      CHANNELS.TERMINAL_STATUS,
      payload
    );
  };
  ptyClient.on("terminal-status", handleTerminalStatus);
  handlers.push(() => ptyClient.off("terminal-status", handleTerminalStatus));

  // Per-target results from a fleet broadcast write. Drives the failure chip
  // and auto-disarm of dead-pipe targets in the renderer.
  const handleBroadcastWriteResult = (payload: BroadcastWriteResultPayload) => {
    broadcastToRenderer(CHANNELS.TERMINAL_BROADCAST_WRITE_RESULT, payload);
  };
  ptyClient.on("broadcast-write-result", handleBroadcastWriteResult);
  handlers.push(() => ptyClient.off("broadcast-write-result", handleBroadcastWriteResult));

  // Agent lifecycle events (agent:state-changed, agent:all-clear, agent:detected,
  // agent:exited, agent:fallback-triggered) are relayed by `registerEventsHandlers`
  // via the multiplexed events:push channel. Emitters continue to publish on
  // `TypedEventBus` (`events.emit(...)`); do not duplicate relays here.

  // Artifact events
  const unsubArtifactDetected = events.on("artifact:detected", (payload: unknown) => {
    broadcastToRenderer(CHANNELS.ARTIFACT_DETECTED, payload);
  });
  handlers.push(unsubArtifactDetected);

  // Resource metrics (batched from pty-host)
  const handleResourceMetrics = (metrics: unknown, timestamp: unknown) => {
    broadcastToRenderer(CHANNELS.TERMINAL_RESOURCE_METRICS, { metrics, timestamp });
  };
  ptyClient.on("resource-metrics", handleResourceMetrics);
  handlers.push(() => ptyClient.off("resource-metrics", handleResourceMetrics));

  // FD leak warning — forwarded to renderer as a diagnostic-only event.
  // Deduplication is handled renderer-side with a 5-min log cooldown.
  const handleFdLeakWarning = (payload: FdLeakWarningPayload) => {
    broadcastToRenderer(CHANNELS.TERMINAL_FD_LEAK_WARNING, payload);
  };
  ptyClient.on("fd-leak-warning", handleFdLeakWarning);
  handlers.push(() => ptyClient.off("fd-leak-warning", handleFdLeakWarning));

  // Terminal activity — per-terminal headline updates, project-scoped like
  // the status pulses above.
  const unsubTerminalActivity = events.on(
    "terminal:activity",
    (payload: DaintreeEventMap["terminal:activity"]) => {
      broadcastToProjectRenderers(
        ptyClient.getTerminalProjectId(payload.terminalId),
        CHANNELS.TERMINAL_ACTIVITY,
        payload
      );
    }
  );
  handlers.push(unsubTerminalActivity);

  // Terminal trash/restore
  const unsubTerminalTrashed = events.on(
    "terminal:trashed",
    (payload: { id: string; expiresAt: number }) => {
      broadcastToRenderer(CHANNELS.TERMINAL_TRASHED, payload);
    }
  );
  handlers.push(unsubTerminalTrashed);

  const unsubTerminalRestored = events.on("terminal:restored", (payload: { id: string }) => {
    broadcastToRenderer(CHANNELS.TERMINAL_RESTORED, payload);
  });
  handlers.push(unsubTerminalRestored);

  // Resume records captured by the pty-host (trash expiry, natural agent
  // exit, `/quit` demotion). Main is the
  // journal's single writer — the pty-host writing the file itself would race
  // main's own close-path writes (two processes, two write queues, one file)
  // — so persist here through the exactly-once journal funnel, keyed by the
  // capture's terminal generation, then signal renderers.
  const unsubSessionCaptured = events.on(
    "agent-session:captured",
    (payload: DaintreeEventMap["agent-session:captured"]) => {
      void journalAgentSession(payload.record, {
        terminalId: payload.terminalId,
        generation: payload.launchGeneration,
      }).catch((err) => {
        console.error("[TerminalEvents] Failed to persist captured agent session:", err);
      });
    }
  );
  handlers.push(unsubSessionCaptured);

  return () => handlers.forEach((cleanup) => cleanup());
}
