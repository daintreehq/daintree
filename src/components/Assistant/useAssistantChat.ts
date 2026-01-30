import { useState, useCallback, useRef, useEffect } from "react";
import type { AssistantMessage, StreamingState, ToolCall } from "./types";
import { actionService } from "@/services/ActionService";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useAssistantChatStore, type ConversationState } from "@/store/assistantChatStore";
import type { AssistantMessage as IPCAssistantMessage } from "@shared/types/assistant";

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatListenerNotification(eventType: string, data: Record<string, unknown>): string {
  if (eventType === "terminal:state-changed") {
    const terminalId = data.terminalId as string | undefined;
    const newState = data.newState as string | undefined;
    const oldState = data.oldState as string | undefined;
    const worktreeId = data.worktreeId as string | undefined;

    const stateEmoji = newState === "completed" ? "✅" : newState === "failed" ? "❌" : "🔔";
    let msg = `${stateEmoji} Terminal state: ${oldState || "unknown"} → ${newState || "unknown"}`;

    if (terminalId) {
      msg += ` (terminal: ${terminalId.slice(0, 8)})`;
    }
    if (worktreeId) {
      msg += ` [${worktreeId}]`;
    }

    return msg;
  }

  return `🔔 Event triggered: ${eventType}`;
}

// Stable default to avoid infinite loops - must be module-level constant
const EMPTY_CONVERSATION: ConversationState = Object.freeze({
  messages: [],
  sessionId: "",
  isLoading: false,
  error: null,
});

interface UseAssistantChatOptions {
  panelId: string;
  onError?: (error: string) => void;
}

export function useAssistantChat(options: UseAssistantChatOptions) {
  const { panelId, onError } = options;

  // Ensure conversation exists on mount - this creates it in the store
  const ensureConversation = useAssistantChatStore((s) => s.ensureConversation);
  useEffect(() => {
    ensureConversation(panelId);
  }, [panelId, ensureConversation]);

  // Get conversation state from global store - access directly to avoid infinite loop
  // The selector must return a stable reference when conversation doesn't exist
  const conversation = useAssistantChatStore((s) => s.conversations[panelId]) ?? EMPTY_CONVERSATION;
  const storeAddMessage = useAssistantChatStore((s) => s.addMessage);
  const storeUpdateLastMessage = useAssistantChatStore((s) => s.updateLastMessage);
  const storeSetLoading = useAssistantChatStore((s) => s.setLoading);
  const storeSetError = useAssistantChatStore((s) => s.setError);
  const storeClearConversation = useAssistantChatStore((s) => s.clearConversation);

  // Streaming state remains local since it's transient and shouldn't survive unmount
  const [streamingState, setStreamingState] = useState<StreamingState | null>(null);

  // Use ref for session ID to maintain stability across the component lifetime
  const sessionIdRef = useRef<string>(conversation.sessionId);
  const currentRequestIdRef = useRef<number>(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Keep session ID ref in sync with store
  useEffect(() => {
    sessionIdRef.current = conversation.sessionId;
  }, [conversation.sessionId]);

  // Mount-level chunk subscription for persistent listener notifications
  useEffect(() => {
    const cleanup = window.electron.assistant.onChunk((data) => {
      if (data.sessionId !== sessionIdRef.current) return;

      const { chunk } = data;

      if (chunk.type === "listener_triggered" && chunk.listenerData) {
        const { eventType, data: eventData } = chunk.listenerData;
        const notificationText = formatListenerNotification(eventType, eventData);
        storeAddMessage(panelId, {
          id: `listener-${Date.now()}-${Math.random()}`,
          role: "assistant",
          content: notificationText,
          timestamp: Date.now(),
        });
      }
    });

    return cleanup;
  }, [panelId, storeAddMessage]);

  const addMessage = useCallback(
    (role: AssistantMessage["role"], content: string) => {
      const message: AssistantMessage = {
        id: generateId(),
        role,
        content,
        timestamp: Date.now(),
      };
      storeAddMessage(panelId, message);
      return message;
    },
    [panelId, storeAddMessage]
  );

  const updateLastMessage = useCallback(
    (updates: Partial<AssistantMessage>) => {
      storeUpdateLastMessage(panelId, updates);
    },
    [panelId, storeUpdateLastMessage]
  );

  const startStreaming = useCallback(() => {
    const newState = { content: "", toolCalls: [] };
    setStreamingState(newState);
    streamingStateRef.current = newState;
  }, []);

  const appendStreamingContent = useCallback((chunk: string) => {
    setStreamingState((prev) => {
      const newState = prev
        ? { ...prev, content: prev.content + chunk }
        : { content: chunk, toolCalls: [] };
      streamingStateRef.current = newState;
      return newState;
    });
  }, []);

  const addStreamingToolCall = useCallback((toolCall: ToolCall) => {
    setStreamingState((prev) => {
      const newState = prev
        ? { ...prev, toolCalls: [...prev.toolCalls, toolCall] }
        : { content: "", toolCalls: [toolCall] };
      streamingStateRef.current = newState;
      return newState;
    });
  }, []);

  const updateStreamingToolCall = useCallback((toolCallId: string, updates: Partial<ToolCall>) => {
    setStreamingState((prev) => {
      if (!prev) return null;
      const newState = {
        ...prev,
        toolCalls: prev.toolCalls.map((tc) => (tc.id === toolCallId ? { ...tc, ...updates } : tc)),
      };
      streamingStateRef.current = newState;
      return newState;
    });
  }, []);

  const streamingStateRef = useRef<StreamingState | null>(null);

  // Keep ref in sync with state for use in finalizeStreaming
  useEffect(() => {
    streamingStateRef.current = streamingState;
  }, [streamingState]);

  const finalizeStreaming = useCallback(() => {
    // Use functional setState to capture the most recent streaming state,
    // avoiding race conditions where streamingStateRef is stale
    setStreamingState((prev) => {
      if (!prev) return null;

      if (prev.content || prev.toolCalls.length > 0) {
        const message: AssistantMessage = {
          id: generateId(),
          role: "assistant",
          content: prev.content,
          timestamp: Date.now(),
          toolCalls: prev.toolCalls.length > 0 ? prev.toolCalls : undefined,
        };
        storeAddMessage(panelId, message);
      }

      // Clear ref after successfully adding message
      streamingStateRef.current = null;
      return null;
    });
  }, [panelId, storeAddMessage]);

  const cancelStreaming = useCallback(() => {
    window.electron.assistant.cancel(sessionIdRef.current);
    cleanupRef.current?.();
    cleanupRef.current = null;
    setStreamingState(null);
    storeSetLoading(panelId, false);
  }, [panelId, storeSetLoading]);

  const clearError = useCallback(() => {
    storeSetError(panelId, null);
  }, [panelId, storeSetError]);

  const clearMessages = useCallback(() => {
    window.electron.assistant.cancel(sessionIdRef.current);
    cleanupRef.current?.();
    cleanupRef.current = null;
    // Invalidate any in-flight requests to prevent race conditions
    currentRequestIdRef.current++;
    storeClearConversation(panelId);
    setStreamingState(null);
    // Session ID is already regenerated by clearConversation, sync the ref
    sessionIdRef.current = useAssistantChatStore.getState().getConversation(panelId).sessionId;
  }, [panelId, storeClearConversation]);

  // Cleanup on unmount only - cancel streaming and clear loading state
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      // Cancel if there's an active stream
      if (streamingStateRef.current) {
        window.electron.assistant.cancel(sessionIdRef.current);
      }
      // Always clear loading state on unmount to prevent stuck state
      storeSetLoading(panelId, false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run on unmount
  }, [panelId]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;

      storeSetError(panelId, null);
      addMessage("user", content);
      storeSetLoading(panelId, true);

      const requestId = ++currentRequestIdRef.current;
      const sessionId = sessionIdRef.current;

      // Clean up previous listener
      cleanupRef.current?.();

      try {
        startStreaming();

        // Get current context
        const projectId = useProjectStore.getState().currentProject?.id;
        const worktreeSelection = useWorktreeSelectionStore.getState();
        const activeWorktreeId = worktreeSelection.activeWorktreeId ?? undefined;
        const focusedWorktreeId = worktreeSelection.focusedWorktreeId ?? undefined;
        const focusedTerminalId = useTerminalStore.getState().focusedId ?? undefined;

        // Get available actions
        const actions = actionService.list();

        // Get current messages from store for the IPC call (includes the message we just added)
        const currentMessages = useAssistantChatStore.getState().getConversation(panelId).messages;

        // Convert messages to IPC format including tool results
        const ipcMessages: IPCAssistantMessage[] = currentMessages.map((msg) => ({
          id: msg.id,
          role: msg.role,
          content: msg.content,
          toolCalls: msg.toolCalls?.map((tc) => ({
            id: tc.id,
            name: tc.name,
            args: tc.args,
          })),
          toolResults: msg.toolCalls
            ?.filter((tc) => tc.status !== "pending" && tc.result !== undefined)
            .map((tc) => ({
              toolCallId: tc.id,
              toolName: tc.name,
              result: tc.result,
              error: tc.error,
            })),
          createdAt: new Date(msg.timestamp).toISOString(),
        }));

        // Subscribe to chunks
        const cleanup = window.electron.assistant.onChunk((data) => {
          // Only process chunks for this session
          if (data.sessionId !== sessionId) return;
          // Ignore if request was superseded
          if (currentRequestIdRef.current !== requestId) return;

          const { chunk } = data;

          switch (chunk.type) {
            case "text":
              if (chunk.content) {
                appendStreamingContent(chunk.content);
              }
              break;

            case "tool_call":
              if (chunk.toolCall) {
                addStreamingToolCall({
                  id: chunk.toolCall.id,
                  name: chunk.toolCall.name,
                  args: chunk.toolCall.args,
                  status: "pending",
                });
              }
              break;

            case "tool_result":
              if (chunk.toolResult) {
                const toolResult = chunk.toolResult;
                // Check if tool call exists before updating
                const toolCallExists = streamingStateRef.current?.toolCalls.some(
                  (tc) => tc.id === toolResult.toolCallId
                );

                if (toolCallExists) {
                  updateStreamingToolCall(toolResult.toolCallId, {
                    status: toolResult.error ? "error" : "success",
                    result: toolResult.result,
                    error: toolResult.error,
                  });
                } else {
                  // Tool result arrived before tool call - create placeholder
                  addStreamingToolCall({
                    id: toolResult.toolCallId,
                    name: toolResult.toolName,
                    args: {},
                    status: toolResult.error ? "error" : "success",
                    result: toolResult.result,
                    error: toolResult.error,
                  });
                }
              }
              break;

            case "error":
              if (chunk.error) {
                storeSetError(panelId, chunk.error);
                onError?.(chunk.error);
              }
              // Finalize and cleanup on error to prevent stuck loading state
              finalizeStreaming();
              storeSetLoading(panelId, false);
              cleanupRef.current?.();
              cleanupRef.current = null;
              break;

            case "listener_triggered":
              break;

            case "done":
              finalizeStreaming();
              storeSetLoading(panelId, false);
              cleanupRef.current?.();
              cleanupRef.current = null;
              break;
          }
        });

        cleanupRef.current = cleanup;

        // Send the message
        await window.electron.assistant.sendMessage({
          sessionId,
          messages: ipcMessages,
          actions,
          context: {
            projectId,
            activeWorktreeId,
            focusedWorktreeId,
            focusedTerminalId,
          },
        });
      } catch (err) {
        if (currentRequestIdRef.current === requestId) {
          const errorMessage = err instanceof Error ? err.message : "An error occurred";
          storeSetError(panelId, errorMessage);
          onError?.(errorMessage);
          setStreamingState(null);
          storeSetLoading(panelId, false);
          // Clean up listener on error
          cleanupRef.current?.();
          cleanupRef.current = null;
          // Cancel the session to avoid dangling stream
          window.electron.assistant.cancel(sessionId);
        }
      }
    },
    [
      panelId,
      addMessage,
      startStreaming,
      appendStreamingContent,
      addStreamingToolCall,
      updateStreamingToolCall,
      finalizeStreaming,
      storeSetError,
      storeSetLoading,
      onError,
    ]
  );

  return {
    messages: conversation.messages,
    streamingState,
    isLoading: conversation.isLoading,
    error: conversation.error,
    sendMessage,
    cancelStreaming,
    clearError,
    clearMessages,
    addMessage,
    updateLastMessage,
    startStreaming,
    appendStreamingContent,
    addStreamingToolCall,
    updateStreamingToolCall,
    finalizeStreaming,
  };
}
