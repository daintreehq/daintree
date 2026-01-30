import { events } from "../events.js";
import { listenerManager } from "./ListenerManager.js";

export type ChunkEmitter = (sessionId: string, chunk: {
  type: "listener_triggered";
  listenerData: {
    listenerId: string;
    eventType: string;
    data: Record<string, unknown>;
  };
}) => void;

let chunkEmitter: ChunkEmitter | null = null;
let unsubscribe: (() => void) | null = null;

export function initTerminalStateListenerBridge(emitter: ChunkEmitter): void {
  if (unsubscribe) {
    destroyTerminalStateListenerBridge();
  }

  chunkEmitter = emitter;

  unsubscribe = events.on("agent:state-changed", (payload) => {
    if (!chunkEmitter) {
      return;
    }

    const eventData = {
      terminalId: payload.terminalId,
      agentId: payload.agentId,
      oldState: payload.previousState,
      newState: payload.state,
      toState: payload.state,
      worktreeId: payload.worktreeId,
      timestamp: payload.timestamp,
    };

    const listeners = listenerManager.getMatchingListeners("terminal:state-changed", eventData);

    for (const listener of listeners) {
      try {
        chunkEmitter(listener.sessionId, {
          type: "listener_triggered",
          listenerData: {
            listenerId: listener.id,
            eventType: "terminal:state-changed",
            data: eventData,
          },
        });
      } catch (error) {
        console.error(
          "[TerminalStateListenerBridge] Failed to emit listener chunk:",
          error instanceof Error ? error.message : error
        );
      }
    }
  });
}

export function destroyTerminalStateListenerBridge(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  chunkEmitter = null;
}
