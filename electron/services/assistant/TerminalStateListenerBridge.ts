import { events } from "../events.js";
import { listenerManager, listenerWaiter } from "./ListenerManager.js";
import { pendingEventQueue } from "./PendingEventQueue.js";
import { continuationManager } from "./ContinuationManager.js";

export type ListenerTriggeredChunk = {
  type: "listener_triggered";
  listenerData: {
    listenerId: string;
    eventType: string;
    data: Record<string, unknown>;
  };
};

export type AutoResumeChunk = {
  type: "auto_resume";
  autoResumeData: {
    eventId: string;
    listenerId: string;
    eventType: string;
    eventData: Record<string, unknown>;
    resumePrompt: string;
    context: {
      plan?: string;
      lastToolCalls?: unknown[];
      metadata?: Record<string, unknown>;
    };
  };
};

export type ChunkEmitter = (
  sessionId: string,
  chunk: ListenerTriggeredChunk | AutoResumeChunk
) => void;

let chunkEmitter: ChunkEmitter | null = null;
const unsubscribers: Array<() => void> = [];

/**
 * Emit event to matching listeners
 */
function emitToListeners(eventType: string, eventData: Record<string, unknown>): void {
  const listeners = listenerManager.getMatchingListeners(eventType, eventData);

  // Log event firing telemetry - only log when no matches (mismatch scenario)
  // The ListenerManager already logs detailed diagnostics for mismatches
  if (listeners.length === 0) {
    console.log(
      `[TerminalStateListenerBridge] ${eventType} fired (no matches)`,
      JSON.stringify({
        terminalId: eventData.terminalId,
      })
    );
  }

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
      // Capture the returned event to get the eventId
      const pendingEvent = pendingEventQueue.push(
        listener.sessionId,
        listener.id,
        eventType,
        eventData
      );

      // Check if there's an active waiter for this listener and notify it
      // If a waiter is active, acknowledge the event immediately since it will be
      // delivered directly via the waiter (not queued for later)
      if (listenerWaiter.isAwaiting(listener.id)) {
        listenerWaiter.notify(listener.id, listenerEvent);
        // Auto-acknowledge since event was delivered to waiter
        pendingEventQueue.acknowledge(pendingEvent.id, listener.sessionId);
      }

      // Check for auto-resume continuation
      const continuation = continuationManager.getByListenerId(listener.id);

      if (chunkEmitter) {
        if (continuation) {
          // Emit auto-resume event instead of regular listener triggered
          // Include the eventId so the renderer can acknowledge it
          chunkEmitter(listener.sessionId, {
            type: "auto_resume",
            autoResumeData: {
              eventId: pendingEvent.id,
              listenerId: listener.id,
              eventType,
              eventData,
              resumePrompt: continuation.resumePrompt,
              context: continuation.context,
            },
          });

          // Clean up the continuation after triggering
          continuationManager.remove(continuation.id);
        } else {
          // Regular listener triggered event
          chunkEmitter(listener.sessionId, {
            type: "listener_triggered",
            listenerData: {
              listenerId: listener.id,
              eventType,
              data: eventData,
            },
          });
        }
      }
      emitSucceeded = true;
    } catch (error) {
      console.error(
        `[TerminalStateListenerBridge] Failed to emit listener chunk for ${eventType}`,
        JSON.stringify({
          listenerId: listener.id.substring(0, 8),
          terminalId: eventData.terminalId,
          error: error instanceof Error ? error.message : String(error),
        })
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
        trigger: payload.trigger,
        confidence: payload.confidence,
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
