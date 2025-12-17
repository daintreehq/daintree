/**
 * Terminal event handlers - forwards events to renderer.
 */

import { CHANNELS } from "../../channels.js";
import { sendToRenderer } from "../../utils.js";
import { events, type CanopyEventMap } from "../../../services/events.js";
import type { HandlerDependencies } from "../../types.js";

export function registerTerminalEventHandlers(deps: HandlerDependencies): () => void {
  const { mainWindow, ptyClient } = deps;
  const handlers: Array<() => void> = [];

  // PTY data/exit/error events
  const handlePtyData = (id: string, data: string | Uint8Array) => {
    sendToRenderer(mainWindow, CHANNELS.TERMINAL_DATA, id, data);
  };
  ptyClient.on("data", handlePtyData);
  handlers.push(() => ptyClient.off("data", handlePtyData));

  const handlePtyExit = (id: string, exitCode: number) => {
    sendToRenderer(mainWindow, CHANNELS.TERMINAL_EXIT, id, exitCode);
  };
  ptyClient.on("exit", handlePtyExit);
  handlers.push(() => ptyClient.off("exit", handlePtyExit));

  const handlePtyError = (id: string, error: string) => {
    sendToRenderer(mainWindow, CHANNELS.TERMINAL_ERROR, id, error);
  };
  ptyClient.on("error", handlePtyError);
  handlers.push(() => ptyClient.off("error", handlePtyError));

  // Terminal status for flow control visibility
  const handleTerminalStatus = (payload: {
    id: string;
    status: string;
    bufferUtilization?: number;
    pauseDuration?: number;
    timestamp: number;
  }) => {
    sendToRenderer(mainWindow, CHANNELS.TERMINAL_STATUS, payload);
  };
  ptyClient.on("terminal-status", handleTerminalStatus);
  handlers.push(() => ptyClient.off("terminal-status", handleTerminalStatus));

  // Agent events
  const unsubAgentState = events.on("agent:state-changed", (payload: unknown) => {
    sendToRenderer(mainWindow, CHANNELS.AGENT_STATE_CHANGED, payload);
  });
  handlers.push(unsubAgentState);

  const unsubAgentDetected = events.on("agent:detected", (payload: unknown) => {
    sendToRenderer(mainWindow, CHANNELS.AGENT_DETECTED, payload);
  });
  handlers.push(unsubAgentDetected);

  const unsubAgentExited = events.on("agent:exited", (payload: unknown) => {
    sendToRenderer(mainWindow, CHANNELS.AGENT_EXITED, payload);
  });
  handlers.push(unsubAgentExited);

  // Artifact events
  const unsubArtifactDetected = events.on("artifact:detected", (payload: unknown) => {
    sendToRenderer(mainWindow, CHANNELS.ARTIFACT_DETECTED, payload);
  });
  handlers.push(unsubArtifactDetected);

  // Terminal activity
  const unsubTerminalActivity = events.on(
    "terminal:activity",
    (payload: CanopyEventMap["terminal:activity"]) => {
      sendToRenderer(mainWindow, CHANNELS.TERMINAL_ACTIVITY, payload);
    }
  );
  handlers.push(unsubTerminalActivity);

  // Terminal trash/restore
  const unsubTerminalTrashed = events.on(
    "terminal:trashed",
    (payload: { id: string; expiresAt: number }) => {
      sendToRenderer(mainWindow, CHANNELS.TERMINAL_TRASHED, payload);
    }
  );
  handlers.push(unsubTerminalTrashed);

  const unsubTerminalRestored = events.on("terminal:restored", (payload: { id: string }) => {
    sendToRenderer(mainWindow, CHANNELS.TERMINAL_RESTORED, payload);
  });
  handlers.push(unsubTerminalRestored);

  return () => handlers.forEach((cleanup) => cleanup());
}
