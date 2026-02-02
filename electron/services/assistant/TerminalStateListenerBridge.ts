import { events } from "../events.js";
import { listenerManager, listenerWaiter } from "./ListenerManager.js";
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
const unsubscribers: Array<() => void> = [];

/**
 * Emit event to matching listeners
 */
function emitToListeners(eventType: string, eventData: Record<string, unknown>): void {
  const listeners = listenerManager.getMatchingListeners(eventType, eventData);

  for (const listener of listeners) {
    let emitSucceeded = false;
    try {
      const listenerEvent = {
        listenerId: listener.id,
        eventType,
        data: eventData,
        timestamp: Date.now(),
      };

      // Always push to pending event queue for reliable delivery
      pendingEventQueue.push(listener.sessionId, listener.id, eventType, eventData);

      // Also check if there's an active waiter for this listener
      listenerWaiter.notify(listener.id, listenerEvent);

      // Also emit real-time chunk for immediate UI feedback if emitter is available
      if (chunkEmitter) {
        chunkEmitter(listener.sessionId, {
          type: "listener_triggered",
          listenerData: {
            listenerId: listener.id,
            eventType,
            data: eventData,
          },
        });
      }
      emitSucceeded = true;
    } catch (error) {
      console.error(
        "[TerminalStateListenerBridge] Failed to emit listener chunk:",
        error instanceof Error ? error.message : error
      );
    }

    if (listener.once && emitSucceeded) {
      listenerManager.unregister(listener.id);
    }
  }
}

export function initTerminalStateListenerBridge(emitter: ChunkEmitter): void {
  if (unsubscribers.length > 0) {
    destroyTerminalStateListenerBridge();
  }

  chunkEmitter = emitter;

  // Bridge agent:state-changed to terminal:state-changed
  unsubscribers.push(
    events.on("agent:state-changed", (payload) => {
      const eventData = {
        terminalId: payload.terminalId,
        agentId: payload.agentId,
        oldState: payload.previousState,
        newState: payload.state,
        toState: payload.state,
        worktreeId: payload.worktreeId,
        timestamp: payload.timestamp,
        traceId: payload.traceId,
      };

      emitToListeners("terminal:state-changed", eventData);
    })
  );

  // Bridge agent:completed
  unsubscribers.push(
    events.on("agent:completed", (payload) => {
      const eventData = {
        agentId: payload.agentId,
        terminalId: payload.terminalId,
        worktreeId: payload.worktreeId,
        exitCode: payload.exitCode,
        duration: payload.duration,
        timestamp: payload.timestamp,
        traceId: payload.traceId,
      };

      emitToListeners("agent:completed", eventData);
    })
  );

  // Bridge agent:failed
  unsubscribers.push(
    events.on("agent:failed", (payload) => {
      const eventData = {
        agentId: payload.agentId,
        terminalId: payload.terminalId,
        worktreeId: payload.worktreeId,
        error: payload.error,
        timestamp: payload.timestamp,
        traceId: payload.traceId,
      };

      emitToListeners("agent:failed", eventData);
    })
  );

  // Bridge agent:killed
  unsubscribers.push(
    events.on("agent:killed", (payload) => {
      const eventData = {
        agentId: payload.agentId,
        terminalId: payload.terminalId,
        worktreeId: payload.worktreeId,
        reason: payload.reason,
        timestamp: payload.timestamp,
        traceId: payload.traceId,
      };

      emitToListeners("agent:killed", eventData);
    })
  );
}

export function destroyTerminalStateListenerBridge(): void {
  for (const unsubscribe of unsubscribers) {
    unsubscribe();
  }
  unsubscribers.length = 0;
  chunkEmitter = null;
}
