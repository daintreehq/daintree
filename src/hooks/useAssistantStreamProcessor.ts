import { useEffect, useRef } from "react";
import { useAssistantChatStore } from "@/store/assistantChatStore";
import type {
  ToolCall,
  EventMetadata,
  AgentStateChangeTrigger,
} from "@/components/Assistant/types";
import { actionService } from "@/services/ActionService";
import { getAssistantContext } from "@/components/Assistant/assistantContext";
import type { AssistantMessage as IPCAssistantMessage } from "@shared/types/assistant";

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatListenerNotification(
  eventType: string,
  data: Record<string, unknown> | null | undefined
): string {
  if (!data || typeof data !== "object") {
    return eventType;
  }

  if (eventType === "terminal:state-changed") {
    const newState = (data.newState as string | undefined) || (data.toState as string | undefined);
    const oldState =
      (data.oldState as string | undefined) || (data.fromState as string | undefined);
    const trigger = data.trigger as string | undefined;
    const rawConfidence = data.confidence;

    let result = `${oldState || "unknown"} → ${newState || "unknown"}`;

    if (
      typeof rawConfidence === "number" &&
      Number.isFinite(rawConfidence) &&
      rawConfidence >= 0 &&
      rawConfidence <= 1
    ) {
      result += ` (${Math.round(rawConfidence * 100)}%)`;
    }

    if (trigger) {
      result += ` [${trigger}]`;
    }

    return result;
  }

  return eventType;
}

function extractEventMetadata(
  eventType: string,
  data: Record<string, unknown> | null | undefined,
  listenerId?: string
): EventMetadata {
  const metadata: EventMetadata = { eventType };

  if (listenerId) {
    metadata.listenerId = listenerId;
  }

  if (!data || typeof data !== "object") {
    return metadata;
  }

  if (eventType === "terminal:state-changed") {
    const terminalId = data.terminalId as string | undefined;
    const worktreeId = data.worktreeId as string | undefined;
    const oldState =
      (data.oldState as string | undefined) || (data.fromState as string | undefined);
    const newState = (data.newState as string | undefined) || (data.toState as string | undefined);
    const trigger = data.trigger as AgentStateChangeTrigger | undefined;
    const rawConfidence = data.confidence;

    if (terminalId) metadata.terminalId = terminalId;
    if (worktreeId) metadata.worktreeId = worktreeId;
    if (oldState) metadata.oldState = oldState;
    if (newState) metadata.newState = newState;
    if (trigger) metadata.trigger = trigger;
    if (
      typeof rawConfidence === "number" &&
      Number.isFinite(rawConfidence) &&
      rawConfidence >= 0 &&
      rawConfidence <= 1
    ) {
      metadata.confidence = rawConfidence;
    }
  }

  return metadata;
}

/**
 * Global hook that processes assistant streaming chunks independently of UI visibility.
 * Mount this once at the app root level to ensure messages continue processing
 * even when the AssistantPane is closed.
 */
interface PendingAutoResume {
  sessionId: string;
  eventId: string;
  eventType: string;
  eventData: Record<string, unknown>;
  resumePrompt: string;
  context: {
    plan?: string;
    lastToolCalls?: unknown[];
    metadata?: Record<string, unknown>;
  };
}

export function useAssistantStreamProcessor() {
  const streamingStateRef = useRef<{ content: string; toolCalls: ToolCall[] } | null>(null);
  const streamingMessageIdRef = useRef<string | null>(null);
  const streamingSessionIdRef = useRef<string | null>(null);
  const hadErrorRef = useRef<boolean>(false);
  const pendingAutoResumeQueueRef = useRef<PendingAutoResume[]>([]);

  useEffect(() => {
    if (!window.electron?.assistant?.onChunk) {
      return;
    }
    function ensureStreamingMessage() {
      if (streamingMessageIdRef.current) return;

      const state = streamingStateRef.current;
      if (!state) return;

      const id = generateId();
      streamingMessageIdRef.current = id;

      useAssistantChatStore.getState().addMessage({
        id,
        role: "assistant",
        content: state.content,
        timestamp: Date.now(),
        toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
      });
    }

    function syncStreamingMessage() {
      const state = streamingStateRef.current;
      if (!state || (!state.content && state.toolCalls.length === 0)) return;

      ensureStreamingMessage();

      const messageId = streamingMessageIdRef.current;
      if (!messageId) return;

      useAssistantChatStore.getState().updateMessage(messageId, {
        content: state.content,
        toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
      });

      // Also update the streaming state in the store so the UI can reflect live streaming
      useAssistantChatStore
        .getState()
        .setStreamingState({ content: state.content, toolCalls: state.toolCalls }, messageId);
    }

    function resetStreamingState() {
      streamingStateRef.current = null;
      streamingMessageIdRef.current = null;
      streamingSessionIdRef.current = null;
      hadErrorRef.current = false;
      useAssistantChatStore.getState().setStreamingState(null, null);
    }

    function processNextAutoResume() {
      // Process next pending auto-resume from queue (FIFO)
      if (pendingAutoResumeQueueRef.current.length > 0) {
        const pending = pendingAutoResumeQueueRef.current.shift()!;
        const remaining = pendingAutoResumeQueueRef.current.length;
        console.log(
          `[AssistantStreamProcessor] Processing next queued auto-resume (${pending.eventType}), ${remaining} remaining`
        );
        processAutoResume(pending);
      }
    }

    async function clearAutoResumeQueue(reason: string) {
      const queueLength = pendingAutoResumeQueueRef.current.length;
      if (queueLength === 0) return;

      console.log(
        `[AssistantStreamProcessor] Clearing ${queueLength} pending auto-resumes due to ${reason}`
      );

      // Best-effort acknowledge all queued events to prevent re-delivery
      const queue = pendingAutoResumeQueueRef.current;
      pendingAutoResumeQueueRef.current = [];

      for (const item of queue) {
        try {
          await window.electron.assistant.acknowledgeEvent(item.sessionId, item.eventId);
        } catch (err) {
          console.error(
            `[AssistantStreamProcessor] Failed to acknowledge queued event ${item.eventId}:`,
            err
          );
        }
      }
    }

    async function processAutoResume(resumeData: PendingAutoResume) {
      const {
        sessionId: resumeSessionId,
        eventId,
        eventType,
        eventData,
        resumePrompt,
        context: resumeContext,
      } = resumeData;

      // Capture current session ID once and reuse throughout this function
      const currentSessionId = useAssistantChatStore.getState().conversation.sessionId;

      // Verify this auto-resume is for the current session
      if (resumeSessionId !== currentSessionId) {
        console.warn(
          `[AssistantStreamProcessor] Dropping queued auto-resume from old session ${resumeSessionId} (current: ${currentSessionId})`
        );
        // Acknowledge the event anyway to clear it from the queue
        try {
          await window.electron.assistant.acknowledgeEvent(resumeSessionId, eventId);
        } catch (err) {
          console.error("[AssistantStreamProcessor] Failed to acknowledge stale event:", err);
        }
        // Process next item in queue
        processNextAutoResume();
        return;
      }

      // Set loading immediately to prevent race conditions with concurrent auto-resumes
      useAssistantChatStore.getState().setLoading(true);

      // Reset streaming and retry state before starting
      resetStreamingState();
      useAssistantChatStore.getState().setRetryState(null);

      // Immediately acknowledge the triggering event so it doesn't appear in pending queue
      try {
        const acknowledged = await window.electron.assistant.acknowledgeEvent(
          currentSessionId,
          eventId
        );
        if (!acknowledged) {
          console.warn(
            `[AssistantStreamProcessor] Event ${eventId} not found or session mismatch during acknowledgment`
          );
        }
      } catch (err) {
        console.error("[AssistantStreamProcessor] Failed to acknowledge event:", err);
        // Continue anyway - acknowledging is best-effort
      }

      // Add system message indicating auto-resume (UI only)
      const eventSummary = formatListenerNotification(eventType, eventData);
      useAssistantChatStore.getState().addMessage({
        id: `system-${Date.now()}-${Math.random()}`,
        role: "system",
        content: `🔄 Auto-resuming: ${eventSummary}`,
        timestamp: Date.now(),
      });

      // Add context as a system note if provided (UI only)
      if (resumeContext.plan) {
        useAssistantChatStore.getState().addMessage({
          id: `system-${Date.now()}-${Math.random()}`,
          role: "system",
          content: `📋 Continuation context:\n${resumeContext.plan}`,
          timestamp: Date.now(),
        });
      }

      // Build a user message that includes event context so the model can see it
      // (system messages are filtered out before sending to the API)
      const eventContextParts: string[] = [];
      eventContextParts.push(`[Auto-resume triggered: ${eventSummary}]`);

      // Include compact event data (capped to avoid MAX_MESSAGE_LENGTH issues)
      if (eventData && Object.keys(eventData).length > 0) {
        const compactData = JSON.stringify(eventData, null, 0);
        const maxDataLength = 500;
        const truncated =
          compactData.length > maxDataLength
            ? compactData.slice(0, maxDataLength) + "..."
            : compactData;
        eventContextParts.push(`\nEvent data: ${truncated}`);
      }

      if (resumeContext.plan) {
        eventContextParts.push(`\nContext: ${resumeContext.plan}`);
      }
      const userMessageContent = `${eventContextParts.join("")}\n\n${resumePrompt}`;

      // Add the resume prompt as a synthetic user message with event context
      useAssistantChatStore.getState().addMessage({
        id: `user-${Date.now()}-${Math.random()}`,
        role: "user",
        content: userMessageContent,
        timestamp: Date.now(),
      });

      // Trigger the assistant to continue
      useAssistantChatStore.getState().setLoading(true);
      useAssistantChatStore.getState().setError(null);

      try {
        const context = getAssistantContext();
        const actions = actionService.list();
        const currentMessages = useAssistantChatStore.getState().conversation.messages;

        // Filter out event and system messages - they are UI-only
        const apiMessages = currentMessages.filter(
          (msg) => msg.role === "user" || msg.role === "assistant"
        );

        const ipcMessages: IPCAssistantMessage[] = apiMessages.map((msg) => {
          const completedToolResults = msg.toolCalls
            ?.filter((tc) => {
              const hasTerminalStatus = tc.status !== "pending";
              const hasResultOrError = tc.result !== undefined || tc.error !== undefined;
              return hasTerminalStatus && hasResultOrError;
            })
            .map((tc) => ({
              toolCallId: tc.id,
              toolName: tc.name,
              result: tc.result ?? null,
              error: tc.error,
            }));

          return {
            id: msg.id,
            role: msg.role as "user" | "assistant",
            content: msg.content,
            toolCalls: msg.toolCalls?.map((tc) => ({
              id: tc.id,
              name: tc.name,
              args: tc.args,
            })),
            toolResults:
              completedToolResults && completedToolResults.length > 0
                ? completedToolResults
                : undefined,
            createdAt: new Date(msg.timestamp).toISOString(),
          };
        });

        // Verify session hasn't changed before sending
        if (useAssistantChatStore.getState().conversation.sessionId !== currentSessionId) {
          console.warn(
            "[AssistantStreamProcessor] Session changed during auto-resume preparation, aborting"
          );
          processNextAutoResume();
          return;
        }

        await window.electron.assistant.sendMessage({
          sessionId: currentSessionId,
          messages: ipcMessages,
          actions,
          context,
        });
      } catch (err) {
        console.error("[AssistantStreamProcessor] Auto-resume error:", err);
        useAssistantChatStore
          .getState()
          .setError(err instanceof Error ? err.message : "Auto-resume failed");
        resetStreamingState();
        useAssistantChatStore.getState().setRetryState(null);
        useAssistantChatStore.getState().setLoading(false);
        // Cancel the session on error - use the captured sessionId
        window.electron.assistant.cancel(currentSessionId);
        // Process next item in queue instead of stalling
        processNextAutoResume();
      }
    }

    function finalizeStreaming() {
      const currentStreaming = streamingStateRef.current;
      if (!currentStreaming) return;

      // Finalize the message if there's content
      if (currentStreaming.content || currentStreaming.toolCalls.length > 0) {
        const messageId = streamingMessageIdRef.current;
        if (messageId) {
          useAssistantChatStore.getState().updateMessage(messageId, {
            content: currentStreaming.content,
            toolCalls:
              currentStreaming.toolCalls.length > 0 ? currentStreaming.toolCalls : undefined,
          });
        } else {
          // No message was created yet (very short response), create one now
          useAssistantChatStore.getState().addMessage({
            id: generateId(),
            role: "assistant",
            content: currentStreaming.content,
            timestamp: Date.now(),
            toolCalls:
              currentStreaming.toolCalls.length > 0 ? currentStreaming.toolCalls : undefined,
          });
        }
      }

      // Reset streaming state
      resetStreamingState();
    }

    // Subscribe to session changes to reset streaming state and clear queue
    const unsubscribe = useAssistantChatStore.subscribe((state, prev) => {
      if (state.conversation.sessionId !== prev.conversation.sessionId) {
        resetStreamingState();
        // Clear pending auto-resume queue for stale session and acknowledge events
        clearAutoResumeQueue("session change");
        // Acknowledge and clear pending auto-resume banner state
        const pending = prev.pendingAutoResume;
        if (pending) {
          window.electron.assistant
            .acknowledgeEvent(pending.sessionId, pending.eventId)
            .catch((err) => {
              console.error(
                "[AssistantStreamProcessor] Failed to acknowledge pending event on session change:",
                err
              );
            });
        }
        useAssistantChatStore.getState().setPendingAutoResume(null);
      }
    });

    const cleanup = window.electron.assistant.onChunk((data) => {
      const currentState = useAssistantChatStore.getState();
      const { sessionId: currentSessionId } = currentState.conversation;

      // Reset streaming state and clear queue if session changed
      if (streamingSessionIdRef.current && streamingSessionIdRef.current !== currentSessionId) {
        resetStreamingState();
        // Clear pending auto-resume queue for stale session and acknowledge events
        clearAutoResumeQueue("session change in chunk handler");
        // Acknowledge and clear pending auto-resume banner state
        const pending = currentState.pendingAutoResume;
        if (pending) {
          window.electron.assistant
            .acknowledgeEvent(pending.sessionId, pending.eventId)
            .catch((err) => {
              console.error(
                "[AssistantStreamProcessor] Failed to acknowledge pending event on session change:",
                err
              );
            });
        }
        useAssistantChatStore.getState().setPendingAutoResume(null);
      }

      // Ignore chunks from different sessions
      if (data.sessionId !== currentSessionId) return;

      // Track current session
      if (!streamingSessionIdRef.current) {
        streamingSessionIdRef.current = currentSessionId;
      }

      const { chunk } = data;

      switch (chunk.type) {
        case "text":
          if (chunk.content) {
            const prev = streamingStateRef.current;
            if (!prev) {
              streamingStateRef.current = { content: chunk.content, toolCalls: [] };
            } else {
              streamingStateRef.current = { ...prev, content: prev.content + chunk.content };
            }
            syncStreamingMessage();
          }
          break;

        case "tool_call":
          if (chunk.toolCall) {
            const prev = streamingStateRef.current;
            const existingToolCall = prev?.toolCalls.find((tc) => tc.id === chunk.toolCall!.id);

            if (existingToolCall) {
              // Update existing tool call
              if (prev) {
                streamingStateRef.current = {
                  ...prev,
                  toolCalls: prev.toolCalls.map((tc) =>
                    tc.id === chunk.toolCall!.id
                      ? { ...tc, name: chunk.toolCall!.name, args: chunk.toolCall!.args }
                      : tc
                  ),
                };
              }
            } else {
              // Add new tool call
              const newToolCall: ToolCall = {
                id: chunk.toolCall.id,
                name: chunk.toolCall.name,
                args: chunk.toolCall.args,
                status: "pending",
              };
              if (!prev) {
                streamingStateRef.current = { content: "", toolCalls: [newToolCall] };
              } else {
                streamingStateRef.current = {
                  ...prev,
                  toolCalls: [...prev.toolCalls, newToolCall],
                };
              }
            }
            syncStreamingMessage();
          }
          break;

        case "tool_result":
          if (chunk.toolResult) {
            const toolResult = chunk.toolResult;
            const prev = streamingStateRef.current;

            // Initialize streaming state if tool_result arrives before other chunks
            if (!prev) {
              streamingStateRef.current = {
                content: "",
                toolCalls: [
                  {
                    id: toolResult.toolCallId,
                    name: toolResult.toolName,
                    args: {},
                    status: toolResult.error ? ("error" as const) : ("success" as const),
                    result: toolResult.result,
                    error: toolResult.error,
                  },
                ],
              };
              syncStreamingMessage();
            } else if (prev) {
              const toolCallExists = prev.toolCalls.some((tc) => tc.id === toolResult.toolCallId);

              if (toolCallExists) {
                streamingStateRef.current = {
                  ...prev,
                  toolCalls: prev.toolCalls.map((tc) =>
                    tc.id === toolResult.toolCallId
                      ? {
                          ...tc,
                          status: toolResult.error ? ("error" as const) : ("success" as const),
                          result: toolResult.result,
                          error: toolResult.error,
                        }
                      : tc
                  ),
                };
              } else {
                // Tool result arrived before tool call (race condition)
                streamingStateRef.current = {
                  ...prev,
                  toolCalls: [
                    ...prev.toolCalls,
                    {
                      id: toolResult.toolCallId,
                      name: toolResult.toolName,
                      args: {},
                      status: toolResult.error ? ("error" as const) : ("success" as const),
                      result: toolResult.result,
                      error: toolResult.error,
                    },
                  ],
                };
              }
              syncStreamingMessage();
            }
          }
          break;

        case "error": {
          if (chunk.error) {
            hadErrorRef.current = true;
            useAssistantChatStore.getState().setError(chunk.error);
          }
          finalizeStreaming();
          useAssistantChatStore.getState().setLoading(false);
          // Clear the entire auto-resume queue on error and acknowledge events
          clearAutoResumeQueue("error");
          // Acknowledge and clear pending auto-resume banner state
          const pendingOnError = useAssistantChatStore.getState().pendingAutoResume;
          if (pendingOnError) {
            window.electron.assistant
              .acknowledgeEvent(pendingOnError.sessionId, pendingOnError.eventId)
              .catch((err) => {
                console.error(
                  "[AssistantStreamProcessor] Failed to acknowledge pending event on error:",
                  err
                );
              });
          }
          useAssistantChatStore.getState().setPendingAutoResume(null);
          break;
        }

        case "listener_triggered":
          if (chunk.listenerData) {
            const { eventType, data: eventData, listenerId } = chunk.listenerData;
            const notificationText = formatListenerNotification(eventType, eventData);
            const eventMetadata = extractEventMetadata(eventType, eventData, listenerId);
            useAssistantChatStore.getState().addMessage({
              id: `listener-${Date.now()}-${Math.random()}`,
              role: "event",
              content: notificationText,
              timestamp: Date.now(),
              eventMetadata,
            });
          }
          break;

        case "auto_resume":
          if (chunk.autoResumeData) {
            const {
              eventId,
              eventType,
              eventData,
              resumePrompt,
              context: resumeContext,
            } = chunk.autoResumeData;

            // Check if currently streaming or loading - if so, queue the auto-resume
            const state = useAssistantChatStore.getState();
            const currentSessionId = state.conversation.sessionId;

            if (state.conversation.isLoading) {
              const queuePosition = pendingAutoResumeQueueRef.current.length + 1;
              console.log(
                `[AssistantStreamProcessor] Auto-resume queued (${eventType}), queue position: ${queuePosition}`
              );
              // Add to queue instead of replacing
              pendingAutoResumeQueueRef.current.push({
                sessionId: currentSessionId,
                eventId,
                eventType,
                eventData,
                resumePrompt,
                context: resumeContext || {},
              });
              // Add event notification
              const notificationText = formatListenerNotification(eventType, eventData);
              useAssistantChatStore.getState().addMessage({
                id: `listener-${Date.now()}-${Math.random()}`,
                role: "event",
                content: `${notificationText} (auto-resume queued #${queuePosition})`,
                timestamp: Date.now(),
              });
              break;
            }

            // Check if user is engaged (input focused or has draft text)
            const isUserEngaged = state.inputHasFocus || state.inputDraftText.trim().length > 0;
            const eventSummary = formatListenerNotification(eventType, eventData);

            if (isUserEngaged) {
              // User is engaged - show grace period banner instead of resuming immediately
              console.log(
                `[AssistantStreamProcessor] User engaged, showing auto-resume prompt for ${eventType}`
              );
              // Acknowledge old pending event if being replaced
              const oldPending = state.pendingAutoResume;
              if (oldPending) {
                window.electron.assistant
                  .acknowledgeEvent(oldPending.sessionId, oldPending.eventId)
                  .catch((err) => {
                    console.error(
                      "[AssistantStreamProcessor] Failed to acknowledge replaced pending event:",
                      err
                    );
                  });
              }
              useAssistantChatStore.getState().setPendingAutoResume({
                eventId,
                eventType,
                eventSummary,
                sessionId: currentSessionId,
                eventData,
                resumePrompt,
                context: resumeContext || {},
                queuedAt: Date.now(),
              });
              // Add event notification
              useAssistantChatStore.getState().addMessage({
                id: `listener-${Date.now()}-${Math.random()}`,
                role: "event",
                content: `${eventSummary} (waiting for input)`,
                timestamp: Date.now(),
              });
            } else {
              // Process auto-resume immediately
              processAutoResume({
                sessionId: currentSessionId,
                eventId,
                eventType,
                eventData,
                resumePrompt,
                context: resumeContext || {},
              });
            }
          }
          break;

        case "retrying": {
          // Server is automatically retrying - show status to user
          if (chunk.retryInfo) {
            const { attempt, maxAttempts } = chunk.retryInfo;
            useAssistantChatStore
              .getState()
              .setRetryState({ attempt, maxAttempts, isRetrying: true });
          }
          // Clear any existing streaming state for clean retry
          resetStreamingState();
          break;
        }

        case "done": {
          // Clear retry state when done
          useAssistantChatStore.getState().setRetryState(null);

          const hadContent = streamingStateRef.current
            ? streamingStateRef.current.content.length > 0 ||
              streamingStateRef.current.toolCalls.length > 0
            : false;

          finalizeStreaming();

          // If we completed without any content and it wasn't cancelled, show an error
          // Note: This now only happens after all automatic retries are exhausted
          // Don't overwrite an existing error message
          if (!hadContent && chunk.finishReason !== "cancelled" && !hadErrorRef.current) {
            useAssistantChatStore
              .getState()
              .setError("The model did not respond. Please try again.");
          }

          useAssistantChatStore.getState().setLoading(false);

          // Process next item in queue
          processNextAutoResume();
          break;
        }
      }
    });

    // Listen for manual auto-resume trigger (from grace period banner)
    const handleTriggerAutoResume = (event: Event) => {
      const customEvent = event as CustomEvent<{
        eventId: string;
        eventType: string;
        sessionId: string;
        eventData: Record<string, unknown>;
        resumePrompt: string;
        context: {
          plan?: string;
          lastToolCalls?: unknown[];
          metadata?: Record<string, unknown>;
        };
      }>;
      const detail = customEvent.detail;
      processAutoResume({
        sessionId: detail.sessionId,
        eventId: detail.eventId,
        eventType: detail.eventType,
        eventData: detail.eventData,
        resumePrompt: detail.resumePrompt,
        context: detail.context,
      });
    };

    window.addEventListener("assistant:triggerAutoResume", handleTriggerAutoResume);

    return () => {
      cleanup();
      unsubscribe();
      window.removeEventListener("assistant:triggerAutoResume", handleTriggerAutoResume);
    };
  }, []);

  // Expose a method to reset streaming state (called when starting a new message)
  return {
    resetStreaming: () => {
      streamingStateRef.current = null;
      streamingMessageIdRef.current = null;
    },
  };
}
