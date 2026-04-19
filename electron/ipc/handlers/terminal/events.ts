/**
 * Terminal event handlers - forwards events to renderer.
 */

import { CHANNELS } from "../../channels.js";
import { broadcastToRenderer } from "../../utils.js";
import { events, type DaintreeEventMap } from "../../../services/events.js";
import type { HandlerDependencies } from "../../types.js";

export function registerTerminalEventHandlers(deps: HandlerDependencies): () => void {
  const { ptyClient } = deps;
  if (!ptyClient) {
    return () => {};
  }
  const handlers: Array<() => void> = [];

  // PTY data/exit/error events
  const handlePtyData = (id: string, data: string | Uint8Array) => {
    broadcastToRenderer(CHANNELS.TERMINAL_DATA, id, data);
  };
  ptyClient.on("data", handlePtyData);
  handlers.push(() => ptyClient.off("data", handlePtyData));

  const handlePtyExit = (id: string, exitCode: number) => {
    broadcastToRenderer(CHANNELS.TERMINAL_EXIT, id, exitCode);
  };
  ptyClient.on("exit", handlePtyExit);
  handlers.push(() => ptyClient.off("exit", handlePtyExit));

  const handlePtyError = (id: string, error: string) => {
    broadcastToRenderer(CHANNELS.TERMINAL_ERROR, id, error);
  };
  ptyClient.on("error", handlePtyError);
  handlers.push(() => ptyClient.off("error", handlePtyError));

  // Spawn result events (success or failure)
  const handleSpawnResult = (
    id: string,
    result: { success: boolean; id: string; error?: unknown }
  ) => {
    broadcastToRenderer(CHANNELS.TERMINAL_SPAWN_RESULT, id, result);
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

  // Agent events
  const unsubAgentState = events.on("agent:state-changed", (payload: unknown) => {
    broadcastToRenderer(CHANNELS.AGENT_STATE_CHANGED, payload);
  });
  handlers.push(unsubAgentState);

  const unsubAllClear = events.on("agent:all-clear", (payload) => {
    broadcastToRenderer(CHANNELS.AGENT_ALL_CLEAR, payload);
  });
  handlers.push(unsubAllClear);

  const unsubAgentDetected = events.on("agent:detected", (payload: unknown) => {
    broadcastToRenderer(CHANNELS.AGENT_DETECTED, payload);
  });
  handlers.push(unsubAgentDetected);

  const unsubAgentExited = events.on("agent:exited", (payload: unknown) => {
    broadcastToRenderer(CHANNELS.AGENT_EXITED, payload);
  });
  handlers.push(unsubAgentExited);

  const unsubFallbackTriggered = events.on("agent:fallback-triggered", (payload: unknown) => {
    broadcastToRenderer(CHANNELS.AGENT_FALLBACK_TRIGGERED, payload);
  });
  handlers.push(unsubFallbackTriggered);

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
