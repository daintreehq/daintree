import { useState, useCallback, useRef, useEffect } from "react";
import type { AssistantMessage, StreamingState, ToolCall } from "./types";
import { actionService } from "@/services/ActionService";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import type { AssistantMessage as IPCAssistantMessage } from "@shared/types/assistant";

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

interface UseAssistantChatOptions {
  onError?: (error: string) => void;
}

export function useAssistantChat(options: UseAssistantChatOptions = {}) {
  const { onError } = options;
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [streamingState, setStreamingState] = useState<StreamingState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string>(generateId());
  const currentRequestIdRef = useRef<number>(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  const addMessage = useCallback((role: AssistantMessage["role"], content: string) => {
    const message: AssistantMessage = {
      id: generateId(),
      role,
      content,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, message]);
    return message;
  }, []);

  const updateLastMessage = useCallback((updates: Partial<AssistantMessage>) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      return [...prev.slice(0, -1), { ...last, ...updates }];
    });
  }, []);

  const startStreaming = useCallback(() => {
    setStreamingState({ content: "", toolCalls: [] });
  }, []);

  const appendStreamingContent = useCallback((chunk: string) => {
    setStreamingState((prev) => {
      if (!prev) return { content: chunk, toolCalls: [] };
      return { ...prev, content: prev.content + chunk };
    });
  }, []);

  const addStreamingToolCall = useCallback((toolCall: ToolCall) => {
    setStreamingState((prev) => {
      if (!prev) return { content: "", toolCalls: [toolCall] };
      return { ...prev, toolCalls: [...prev.toolCalls, toolCall] };
    });
  }, []);

  const updateStreamingToolCall = useCallback((toolCallId: string, updates: Partial<ToolCall>) => {
    setStreamingState((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        toolCalls: prev.toolCalls.map((tc) => (tc.id === toolCallId ? { ...tc, ...updates } : tc)),
      };
    });
  }, []);

  const streamingStateRef = useRef<StreamingState | null>(null);

  // Keep ref in sync with state for use in finalizeStreaming
  useEffect(() => {
    streamingStateRef.current = streamingState;
  }, [streamingState]);

  const finalizeStreaming = useCallback(() => {
    // Capture streaming state from ref to avoid closure issues and prevent double-add
    const prev = streamingStateRef.current;
    if (!prev) return;

    // Clear the ref immediately to prevent double finalization
    streamingStateRef.current = null;

    if (prev.content || prev.toolCalls.length > 0) {
      const message: AssistantMessage = {
        id: generateId(),
        role: "assistant",
        content: prev.content,
        timestamp: Date.now(),
        toolCalls: prev.toolCalls.length > 0 ? prev.toolCalls : undefined,
      };
      setMessages((msgs) => [...msgs, message]);
    }

    setStreamingState(null);
  }, []);

  const cancelStreaming = useCallback(() => {
    window.electron.assistant.cancel(sessionIdRef.current);
    cleanupRef.current?.();
    cleanupRef.current = null;
    setStreamingState(null);
    setIsLoading(false);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const clearMessages = useCallback(() => {
    window.electron.assistant.cancel(sessionIdRef.current);
    cleanupRef.current?.();
    cleanupRef.current = null;
    setMessages([]);
    setStreamingState(null);
    setError(null);
    setIsLoading(false);
    // Generate new session ID for fresh conversation
    sessionIdRef.current = generateId();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      window.electron.assistant.cancel(sessionIdRef.current);
    };
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;

      setError(null);
      addMessage("user", content);
      setIsLoading(true);

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

        // Convert messages to IPC format including tool results
        const ipcMessages: IPCAssistantMessage[] = messages
          .concat({
            id: generateId(),
            role: "user",
            content,
            timestamp: Date.now(),
          })
          .map((msg) => ({
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
                updateStreamingToolCall(chunk.toolResult.toolCallId, {
                  status: chunk.toolResult.error ? "error" : "success",
                  result: chunk.toolResult.result,
                  error: chunk.toolResult.error,
                });
              }
              break;

            case "error":
              if (chunk.error) {
                setError(chunk.error);
                onError?.(chunk.error);
              }
              break;

            case "done":
              finalizeStreaming();
              setIsLoading(false);
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
          setError(errorMessage);
          onError?.(errorMessage);
          setStreamingState(null);
          setIsLoading(false);
          // Clean up listener on error
          cleanupRef.current?.();
          cleanupRef.current = null;
          // Cancel the session to avoid dangling stream
          window.electron.assistant.cancel(sessionId);
        }
      }
    },
    [
      messages,
      addMessage,
      startStreaming,
      appendStreamingContent,
      addStreamingToolCall,
      updateStreamingToolCall,
      finalizeStreaming,
      onError,
    ]
  );

  return {
    messages,
    streamingState,
    isLoading,
    error,
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
