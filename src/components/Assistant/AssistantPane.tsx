import { useEffect, useRef, useCallback } from "react";
import { Loader2, XCircle, X, RefreshCw, Maximize2 } from "lucide-react";
import { CanopyIcon } from "@/components/icons/CanopyIcon";
import { useAppAgentStore, useAssistantChatStore } from "@/store";
import { MessageList } from "./MessageList";
import { AssistantInput, type AssistantInputHandle } from "./AssistantInput";
import { EmptyState } from "./EmptyState";
import { useAssistantChat } from "./useAssistantChat";

export function AssistantPane() {
  const { hasApiKey, isInitialized, initialize } = useAppAgentStore();
  const { close } = useAssistantChatStore();
  const inputRef = useRef<AssistantInputHandle>(null);

  const {
    messages,
    streamingState,
    streamingMessageId,
    isLoading,
    error,
    sendMessage,
    cancelStreaming,
    clearError,
    clearMessages,
  } = useAssistantChat();

  useEffect(() => {
    initialize();
  }, [initialize]);

  const handleSubmit = useCallback(
    (value: string) => {
      sendMessage(value);
      inputRef.current?.focus();
    },
    [sendMessage]
  );

  const handleClearConversation = useCallback(() => {
    if (messages.length > 1 || isLoading) {
      const confirmed = window.confirm("Clear conversation? This cannot be undone.");
      if (!confirmed) return;
    }
    clearMessages();
  }, [clearMessages, messages.length, isLoading]);

  const showLoading = !isInitialized;
  const showNoApiKey = isInitialized && !hasApiKey;
  const showChat = isInitialized && hasApiKey;
  const hasMessages = messages.length > 0;

  return (
    <div className="flex flex-col h-full bg-canopy-bg">
      {showLoading && (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 text-canopy-text/40 animate-spin" />
        </div>
      )}

      {showNoApiKey && <EmptyState />}

      {showChat && (
        <>
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-divider bg-canopy-sidebar select-none">
            <div className="flex items-center gap-2.5">
              <CanopyIcon size={16} className="text-canopy-accent" />
              <span className="font-semibold text-sm text-canopy-text">Canopy Assistant</span>
            </div>
            <div className="flex items-center gap-4 text-canopy-text/50">
              {hasMessages && (
                <button
                  type="button"
                  onClick={handleClearConversation}
                  className="hover:text-canopy-text transition-colors"
                  title="Clear conversation"
                >
                  <RefreshCw size={14} />
                </button>
              )}
              <button
                type="button"
                className="hover:text-canopy-text transition-colors"
                title="Maximize"
              >
                <Maximize2 size={14} />
              </button>
              <button
                type="button"
                onClick={close}
                className="hover:text-canopy-text hover:text-red-400 transition-colors"
                aria-label="Close assistant"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {hasMessages ? (
            <MessageList
              messages={messages}
              streamingState={streamingState}
              streamingMessageId={streamingMessageId}
              isLoading={isLoading}
              className="flex-1 min-h-0"
            />
          ) : (
            <EmptyState onSubmit={handleSubmit} />
          )}

          {error && (
            <div
              className="flex items-start gap-3 px-4 py-2.5 border-l-2 border-red-500 bg-red-500/[0.03]"
              role="alert"
            >
              <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
              <span className="flex-1 font-mono text-xs text-red-400 whitespace-pre-wrap break-words">
                {error}
              </span>
              <button
                type="button"
                onClick={clearError}
                className="text-red-400/70 hover:text-red-400 transition-colors"
                aria-label="Dismiss error"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          <AssistantInput
            ref={inputRef}
            onSubmit={handleSubmit}
            onCancel={cancelStreaming}
            isStreaming={isLoading}
            disabled={isLoading}
            placeholder="Execute a command or ask a question..."
          />
        </>
      )}
    </div>
  );
}
