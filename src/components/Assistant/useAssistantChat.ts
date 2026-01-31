import { useState, useCallback, useRef, useEffect } from "react";
import type { AssistantMessage, StreamingState, ToolCall } from "./types";
import { actionService } from "@/services/ActionService";
import { useAssistantChatStore } from "@/store/assistantChatStore";
import type { AssistantMessage as IPCAssistantMessage } from "@shared/types/assistant";
import { getAssistantContext } from "./assistantContext";

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

interface UseAssistantChatOptions {
  onError?: (error: string) => void;
}

export function useAssistantChat(options?: UseAssistantChatOptions) {
  const { onError } = options ?? {};

  // Get conversation state from global store
  const conversation = useAssistantChatStore((s) => s.conversation);
  const storeAddMessage = useAssistantChatStore((s) => s.addMessage);
  const storeUpdateMessage = useAssistantChatStore((s) => s.updateMessage);
  const storeUpdateLastMessage = useAssistantChatStore((s) => s.updateLastMessage);
  const storeSetLoading = useAssistantChatStore((s) => s.setLoading);
  const storeSetError = useAssistantChatStore((s) => s.setError);
  const storeClearConversation = useAssistantChatStore((s) => s.clearConversation);

  // Streaming state remains local since it's transient and shouldn't survive unmount
  const [streamingState, setStreamingState] = useState<StreamingState | null>(null);
  const streamingStateRef = useRef<StreamingState | null>(null);
  const streamingMessageIdRef = useRef<string | null>(null);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);

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
        storeAddMessage({
          id: `listener-${Date.now()}-${Math.random()}`,
          role: "assistant",
          content: notificationText,
          timestamp: Date.now(),
        });
      }
    });

    return cleanup;
  }, [storeAddMessage]);

  const addMessage = useCallback(
    (role: AssistantMessage["role"], content: string) => {
      const message: AssistantMessage = {
        id: generateId(),
        role,
        content,
        timestamp: Date.now(),
      };
      storeAddMessage(message);
      return message;
    },
    [storeAddMessage]
  );

  const updateLastMessage = useCallback(
    (updates: Partial<AssistantMessage>) => {
      storeUpdateLastMessage(updates);
    },
    [storeUpdateLastMessage]
  );

  const setStreamingStateSync = useCallback(
    (next: StreamingState | null) => {
      streamingStateRef.current = next;
      setStreamingState(next);
    },
    [setStreamingState]
  );

  const ensureStreamingMessage = useCallback(
    (state: StreamingState) => {
      if (streamingMessageIdRef.current) return;
      const id = generateId();
      streamingMessageIdRef.current = id;
      setStreamingMessageId(id);
      storeAddMessage({
        id,
        role: "assistant",
        content: state.content,
        timestamp: Date.now(),
        toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
      });
    },
    [storeAddMessage]
  );

  const syncStreamingMessage = useCallback(
    (state: StreamingState) => {
      if (!state.content && state.toolCalls.length === 0) return;
      ensureStreamingMessage(state);
      const messageId = streamingMessageIdRef.current;
      if (!messageId) return;
      storeUpdateMessage(messageId, {
        content: state.content,
        toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
      });
    },
    [ensureStreamingMessage, storeUpdateMessage]
  );

  const startStreaming = useCallback(() => {
    const newState = { content: "", toolCalls: [] };
    setStreamingStateSync(newState);
    streamingMessageIdRef.current = null;
    setStreamingMessageId(null);
  }, [setStreamingStateSync]);

  const appendStreamingContent = useCallback(
    (chunk: string) => {
      const prev = streamingStateRef.current;
      if (!prev) {
        const newState = { content: chunk, toolCalls: [] };
        setStreamingStateSync(newState);
        syncStreamingMessage(newState);
      } else {
        const newState = { ...prev, content: prev.content + chunk };
        setStreamingStateSync(newState);
        syncStreamingMessage(newState);
      }
    },
    [setStreamingStateSync, syncStreamingMessage]
  );

  const addStreamingToolCall = useCallback(
    (toolCall: ToolCall) => {
      const prev = streamingStateRef.current;
      if (!prev) {
        const newState = { content: "", toolCalls: [toolCall] };
        setStreamingStateSync(newState);
        syncStreamingMessage(newState);
      } else {
        const newState = { ...prev, toolCalls: [...prev.toolCalls, toolCall] };
        setStreamingStateSync(newState);
        syncStreamingMessage(newState);
      }
    },
    [setStreamingStateSync, syncStreamingMessage]
  );

  const updateStreamingToolCall = useCallback(
    (toolCallId: string, updates: Partial<ToolCall>) => {
      const prev = streamingStateRef.current;
      if (!prev) return;
      const newState = {
        ...prev,
        toolCalls: prev.toolCalls.map((tc) => (tc.id === toolCallId ? { ...tc, ...updates } : tc)),
      };
      setStreamingStateSync(newState);
      syncStreamingMessage(newState);
    },
    [setStreamingStateSync, syncStreamingMessage]
  );

  // Keep ref in sync with state for use in finalizeStreaming
  useEffect(() => {
    streamingStateRef.current = streamingState;
  }, [streamingState]);

  const finalizeStreaming = useCallback(() => {
    const currentStreaming = streamingStateRef.current;
    if (!currentStreaming) return;

    streamingStateRef.current = null;

    if (currentStreaming.content || currentStreaming.toolCalls.length > 0) {
      const messageId = streamingMessageIdRef.current;
      if (messageId) {
        storeUpdateMessage(messageId, {
          content: currentStreaming.content,
          toolCalls: currentStreaming.toolCalls.length > 0 ? currentStreaming.toolCalls : undefined,
        });
      } else {
        storeAddMessage({
          id: generateId(),
          role: "assistant",
          content: currentStreaming.content,
          timestamp: Date.now(),
          toolCalls: currentStreaming.toolCalls.length > 0 ? currentStreaming.toolCalls : undefined,
        });
      }
    }
    setTimeout(() => {
      setStreamingStateSync(null);
      streamingMessageIdRef.current = null;
      setStreamingMessageId(null);
    }, 0);
  }, [storeAddMessage, storeUpdateMessage, setStreamingStateSync]);

  const cancelStreaming = useCallback(() => {
    window.electron.assistant.cancel(sessionIdRef.current);
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (
      streamingStateRef.current &&
      (streamingStateRef.current.content || streamingStateRef.current.toolCalls.length > 0)
    ) {
      syncStreamingMessage(streamingStateRef.current);
    }
    setStreamingStateSync(null);
    setTimeout(() => {
      streamingMessageIdRef.current = null;
      setStreamingMessageId(null);
    }, 0);
    storeSetLoading(false);
  }, [storeSetLoading, setStreamingStateSync, syncStreamingMessage]);

  const clearError = useCallback(() => {
    storeSetError(null);
  }, [storeSetError]);

  const clearMessages = useCallback(() => {
    window.electron.assistant.cancel(sessionIdRef.current);
    cleanupRef.current?.();
    cleanupRef.current = null;
    currentRequestIdRef.current++;
    storeClearConversation();
    streamingMessageIdRef.current = null;
    setStreamingMessageId(null);
    setStreamingStateSync(null);
    sessionIdRef.current = useAssistantChatStore.getState().conversation.sessionId;
  }, [storeClearConversation, setStreamingStateSync]);

  // Cleanup on unmount only - cancel streaming and clear loading state
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (streamingStateRef.current) {
        window.electron.assistant.cancel(sessionIdRef.current);
      }
      storeSetLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;

      storeSetError(null);
      addMessage("user", content);
      storeSetLoading(true);

      const requestId = ++currentRequestIdRef.current;
      const sessionId = sessionIdRef.current;

      cleanupRef.current?.();

      streamingStateRef.current = null;
      setStreamingStateSync(null);
      streamingMessageIdRef.current = null;
      setStreamingMessageId(null);

      try {
        const context = getAssistantContext();
        const actions = actionService.list();

        const currentMessages = useAssistantChatStore.getState().conversation.messages;

        const ipcMessages: IPCAssistantMessage[] = currentMessages.map((msg) => {
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
            role: msg.role,
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

        const cleanup = window.electron.assistant.onChunk((data) => {
          if (data.sessionId !== sessionId) return;
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
                const existingToolCall = streamingStateRef.current?.toolCalls.find(
                  (tc) => tc.id === chunk.toolCall!.id
                );

                if (existingToolCall) {
                  updateStreamingToolCall(chunk.toolCall.id, {
                    name: chunk.toolCall.name,
                    args: chunk.toolCall.args,
                  });
                } else {
                  addStreamingToolCall({
                    id: chunk.toolCall.id,
                    name: chunk.toolCall.name,
                    args: chunk.toolCall.args,
                    status: "pending",
                  });
                }
              }
              break;

            case "tool_result":
              if (chunk.toolResult) {
                const toolResult = chunk.toolResult;
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
                storeSetError(chunk.error);
                onError?.(chunk.error);
              }
              finalizeStreaming();
              storeSetLoading(false);
              cleanupRef.current?.();
              cleanupRef.current = null;
              break;

            case "listener_triggered":
              break;

            case "done":
              finalizeStreaming();
              storeSetLoading(false);
              cleanupRef.current?.();
              cleanupRef.current = null;
              break;
          }
        });

        cleanupRef.current = cleanup;

        await window.electron.assistant.sendMessage({
          sessionId,
          messages: ipcMessages,
          actions,
          context,
        });
      } catch (err) {
        if (currentRequestIdRef.current === requestId) {
          const errorMessage = err instanceof Error ? err.message : "An error occurred";
          storeSetError(errorMessage);
          onError?.(errorMessage);
          setStreamingStateSync(null);
          storeSetLoading(false);
          cleanupRef.current?.();
          cleanupRef.current = null;
          window.electron.assistant.cancel(sessionId);
        }
      }
    },
    [
      addMessage,
      startStreaming,
      appendStreamingContent,
      addStreamingToolCall,
      updateStreamingToolCall,
      finalizeStreaming,
      storeSetError,
      storeSetLoading,
      onError,
      setStreamingStateSync,
    ]
  );

  return {
    messages: conversation.messages,
    streamingState,
    streamingMessageId,
    isLoading: conversation.isLoading,
    error: conversation.error,
    sendMessage,
    cancelStreaming,
    clearError,
    clearMessages,
    addMessage,
    updateLastMessage,
    appendStreamingContent,
    addStreamingToolCall,
    updateStreamingToolCall,
    finalizeStreaming,
  };
}
