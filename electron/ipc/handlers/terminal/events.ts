/**
 * Terminal event handlers - forwards events to renderer.
 */

import { CHANNELS } from "../../channels.js";
import { broadcastToRenderer } from "../../utils.js";
import { events, type DaintreeEventMap } from "../../../services/events.js";
import type {
  SpawnResult,
  BroadcastWriteResultPayload,
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

  // Spawn result events (success or failure)
  const handleSpawnResult = (id: string, result: SpawnResult) => {
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "terminal:spawn-result",
      payload: [id, result],
    });
  };
  ptyClient.on("spawn-result", handleSpawnResult);
  handlers.push(() => ptyClient.off("spawn-result", handleSpawnResult));

  // Terminal status for flow control visibility
  const handleTerminalStatus = (payload: {
    id: string;
    status: string;
    bufferUtilization?: number;
    pauseDuration?: number;
    timestamp: number;
  }) => {
    broadcastToRenderer(CHANNELS.TERMINAL_STATUS, payload);
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

  // Terminal activity
  const unsubTerminalActivity = events.on(
    "terminal:activity",
    (payload: DaintreeEventMap["terminal:activity"]) => {
      broadcastToRenderer(CHANNELS.TERMINAL_ACTIVITY, payload);
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

  return () => handlers.forEach((cleanup) => cleanup());
}
