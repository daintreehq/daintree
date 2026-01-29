import { useState, useCallback, useRef, useEffect } from "react";
import type { AssistantMessage, StreamingState, ToolCall } from "./types";

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
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentRequestIdRef = useRef<number>(0);

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

  const finalizeStreaming = useCallback(() => {
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
        setMessages((msgs) => [...msgs, message]);
      }

      return null;
    });
  }, []);

  const cancelStreaming = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setStreamingState(null);
    setIsLoading(false);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const clearMessages = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setMessages([]);
    setStreamingState(null);
    setError(null);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;

      setError(null);
      addMessage("user", content);
      setIsLoading(true);

      const requestId = ++currentRequestIdRef.current;
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        startStreaming();

        // TODO: Integrate with actual assistant backend
        // For now, simulate a response
        await new Promise((resolve) => setTimeout(resolve, 500));

        const mockResponse =
          "I'm the Canopy Assistant. I can help you with:\n\n" +
          "- **Code questions** - Ask about patterns, best practices, or debugging\n" +
          "- **Project navigation** - Find files, understand structure\n" +
          "- **Terminal commands** - Get help with git, npm, and more\n\n" +
          "```typescript\n" +
          "// Example: I can explain code like this\n" +
          "const greeting = (name: string) => `Hello, ${name}!`;\n" +
          "```\n\n" +
          "What would you like help with?";

        // Simulate streaming
        for (const char of mockResponse) {
          if (controller.signal.aborted || currentRequestIdRef.current !== requestId) {
            break;
          }
          appendStreamingContent(char);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }

        if (currentRequestIdRef.current === requestId) {
          finalizeStreaming();
        }
      } catch (err) {
        if (currentRequestIdRef.current === requestId) {
          const errorMessage = err instanceof Error ? err.message : "An error occurred";
          setError(errorMessage);
          onError?.(errorMessage);
          setStreamingState(null);
        }
      } finally {
        if (currentRequestIdRef.current === requestId) {
          setIsLoading(false);
          if (abortControllerRef.current === controller) {
            abortControllerRef.current = null;
          }
        }
      }
    },
    [addMessage, startStreaming, appendStreamingContent, finalizeStreaming, onError]
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
