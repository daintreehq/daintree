import { events } from "../events.js";
import { listenerManager } from "./ListenerManager.js";
import { pendingEventQueue } from "./PendingEventQueue.js";

export type ChunkEmitter = (
  sessionId: string,
  chunk: {
    type: "listener_triggered";
    listenerData: {
      listenerId: string;
      eventType: string;
      data: Record<string, unknown>;
    };
  }
) => void;

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
        // Push to pending event queue for reliable delivery
        pendingEventQueue.push(
          listener.sessionId,
          listener.id,
          "terminal:state-changed",
          eventData
        );

        // Also emit real-time chunk for immediate UI feedback
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
      } finally {
        if (listener.once) {
          listenerManager.unregister(listener.id);
        }
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
