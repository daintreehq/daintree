import { useCallback, useRef, useEffect } from "react";
import type { AssistantMessage } from "./types";
import { actionService } from "@/services/ActionService";
import { useAssistantChatStore } from "@/store/assistantChatStore";
import type { AssistantMessage as IPCAssistantMessage } from "@shared/types/assistant";
import { getAssistantContext } from "./assistantContext";

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

interface UseAssistantChatOptions {
  onError?: (error: string) => void;
}

export function useAssistantChat(options?: UseAssistantChatOptions) {
  const { onError } = options ?? {};

  // Get conversation state from global store
  const conversation = useAssistantChatStore((s) => s.conversation);
  const streamingState = useAssistantChatStore((s) => s.streamingState);
  const streamingMessageId = useAssistantChatStore((s) => s.streamingMessageId);
  const retryState = useAssistantChatStore((s) => s.retryState);
  const storeAddMessage = useAssistantChatStore((s) => s.addMessage);
  const storeUpdateLastMessage = useAssistantChatStore((s) => s.updateLastMessage);
  const storeSetLoading = useAssistantChatStore((s) => s.setLoading);
  const storeSetError = useAssistantChatStore((s) => s.setError);
  const storeClearConversation = useAssistantChatStore((s) => s.clearConversation);
  const storeSetStreamingState = useAssistantChatStore((s) => s.setStreamingState);

  // Use ref for session ID to maintain stability across the component lifetime
  const sessionIdRef = useRef<string>(conversation.sessionId);
  const currentRequestIdRef = useRef<number>(0);

  // Keep session ID ref in sync with store
  useEffect(() => {
    sessionIdRef.current = conversation.sessionId;
  }, [conversation.sessionId]);

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

  const cancelStreaming = useCallback(() => {
    window.electron.assistant.cancel(sessionIdRef.current);
    storeSetStreamingState(null, null);
    useAssistantChatStore.getState().setRetryState(null);
    storeSetLoading(false);
  }, [storeSetLoading, storeSetStreamingState]);

  const clearError = useCallback(() => {
    storeSetError(null);
  }, [storeSetError]);

  const clearMessages = useCallback(() => {
    window.electron.assistant.cancel(sessionIdRef.current);
    currentRequestIdRef.current++;
    storeClearConversation();
    sessionIdRef.current = useAssistantChatStore.getState().conversation.sessionId;
  }, [storeClearConversation]);

  const retryLastMessage = useCallback(() => {
    const state = useAssistantChatStore.getState();

    if (state.conversation.isLoading) {
      console.warn("[AssistantChat] Cannot retry while request is in progress");
      return;
    }

    const messages = state.conversation.messages;
    let lastUserMessageIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        lastUserMessageIndex = i;
        break;
      }
    }

    if (lastUserMessageIndex === -1) {
      console.warn("[AssistantChat] No user message to retry");
      return;
    }

    const messagesToRetry = messages.slice(0, lastUserMessageIndex + 1);
    useAssistantChatStore.getState().setMessages(messagesToRetry);

    storeSetError(null);
    storeSetLoading(true);

    const requestId = ++currentRequestIdRef.current;
    const sessionId = sessionIdRef.current;

    storeSetStreamingState(null, null);
    useAssistantChatStore.getState().setRetryState(null);

    (async () => {
      try {
        const context = getAssistantContext();
        const actions = actionService.list();

        const currentMessages = messagesToRetry;

        // Filter out event messages - they are UI-only and should not be sent to the API
        const apiMessages = currentMessages.filter(
          (msg) => msg.role === "user" || msg.role === "assistant"
        );

        const ipcMessages = apiMessages.map((msg) => {
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

        await window.electron.assistant.sendMessage({
          sessionId,
          messages: ipcMessages,
          actions,
          context,
        });
      } catch (err) {
        if (currentRequestIdRef.current === requestId) {
          const errorMessage = err instanceof Error ? err.message : "An error occurred";
          console.error("[AssistantChat] Retry error:", errorMessage);
          storeSetError(errorMessage);
          onError?.(errorMessage);
          storeSetStreamingState(null, null);
          storeSetLoading(false);
          window.electron.assistant.cancel(sessionId);
        }
      }
    })();
  }, [storeSetError, storeSetLoading, onError, storeSetStreamingState]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;

      storeSetError(null);
      addMessage("user", content);
      storeSetLoading(true);

      const requestId = ++currentRequestIdRef.current;
      const sessionId = sessionIdRef.current;

      // Reset streaming state for new message
      storeSetStreamingState(null, null);
      useAssistantChatStore.getState().setRetryState(null);

      try {
        const context = getAssistantContext();
        const actions = actionService.list();

        const currentMessages = useAssistantChatStore.getState().conversation.messages;

        // Filter out event messages - they are UI-only and should not be sent to the API
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

        await window.electron.assistant.sendMessage({
          sessionId,
          messages: ipcMessages,
          actions,
          context,
        });
      } catch (err) {
        if (currentRequestIdRef.current === requestId) {
          const errorMessage = err instanceof Error ? err.message : "An error occurred";
          console.error("[AssistantChat] Error:", errorMessage);
          storeSetError(errorMessage);
          onError?.(errorMessage);
          storeSetStreamingState(null, null);
          storeSetLoading(false);
          window.electron.assistant.cancel(sessionId);
        }
      }
    },
    [addMessage, storeSetError, storeSetLoading, onError, storeSetStreamingState]
  );

  return {
    messages: conversation.messages,
    streamingState,
    streamingMessageId,
    isLoading: conversation.isLoading,
    error: conversation.error,
    retryState,
    sendMessage,
    retryLastMessage,
    cancelStreaming,
    clearError,
    clearMessages,
    addMessage,
    updateLastMessage,
  };
}
