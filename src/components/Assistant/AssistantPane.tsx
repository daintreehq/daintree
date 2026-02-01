import { useEffect, useRef, useCallback, useState } from "react";
import { Loader2, XCircle, X, RefreshCw, Maximize2, RotateCw } from "lucide-react";
import { CanopyIcon } from "@/components/icons/CanopyIcon";
import { useAppAgentStore, useAssistantChatStore } from "@/store";
import { cn } from "@/lib/utils";
import { MessageList } from "./MessageList";
import { AssistantInput, type AssistantInputHandle } from "./AssistantInput";
import { EmptyState } from "./EmptyState";
import { useAssistantChat } from "./useAssistantChat";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export function AssistantPane() {
  const { hasApiKey, isInitialized, initialize } = useAppAgentStore();
  const { isOpen, close } = useAssistantChatStore();
  const inputRef = useRef<AssistantInputHandle>(null);

  const {
    messages,
    streamingState,
    streamingMessageId,
    isLoading,
    error,
    sendMessage,
    retryLastMessage,
    cancelStreaming,
    clearError,
    clearMessages,
  } = useAssistantChat();

  const showLoading = !isInitialized;
  const showNoApiKey = isInitialized && !hasApiKey;
  const showChat = isInitialized && hasApiKey;
  const hasMessages = messages.length > 0;

  useEffect(() => {
    initialize();
  }, [initialize]);

  // Focus input when assistant opens and chat UI is ready
  useEffect(() => {
    if (!isOpen || !showChat || isLoading) return;

    const rafId = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(rafId);
  }, [isOpen, showChat, isLoading]);

  const handleSubmit = useCallback(
    (value: string) => {
      sendMessage(value);
      inputRef.current?.focus();
    },
    [sendMessage]
  );

  const [showClearDialog, setShowClearDialog] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const handleClearConversation = useCallback(() => {
    if (messages.length > 0 || isLoading) {
      setShowClearDialog(true);
    } else {
      clearMessages();
    }
  }, [clearMessages, messages.length, isLoading]);

  const handleConfirmClear = useCallback(async () => {
    if (isClearing) return;
    setIsClearing(true);
    setShowClearDialog(false);

    if (isLoading) {
      cancelStreaming();
    }
    clearMessages();
    setIsClearing(false);

    // Return focus to input after clearing (clear button is removed when messages are cleared)
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [clearMessages, cancelStreaming, isLoading, isClearing]);

  useEffect(() => {
    if (!isOpen && showClearDialog) {
      setShowClearDialog(false);
    }
  }, [isOpen, showClearDialog]);

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
          <div
            className={cn(
              "flex items-center justify-between px-3 shrink-0 text-xs transition-colors relative overflow-hidden group",
              "h-8 border-b border-divider",
              "bg-white/[0.02]"
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5">
                <CanopyIcon className="w-3.5 h-3.5 text-canopy-accent" />
              </span>
              <span className="text-xs font-medium font-sans text-canopy-text truncate select-none transition-colors">
                Canopy Assistant
              </span>
            </div>
            <div className="flex items-center gap-1.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity motion-reduce:transition-none">
              {hasMessages && (
                <button
                  type="button"
                  onClick={handleClearConversation}
                  className="p-1.5 hover:bg-canopy-text/10 focus-visible:bg-canopy-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2 text-canopy-text/60 hover:text-canopy-text transition-colors"
                  title="Clear conversation"
                  aria-label="Clear conversation"
                >
                  <RefreshCw className="w-3 h-3" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="p-1.5 hover:bg-canopy-text/10 focus-visible:bg-canopy-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2 text-canopy-text/60 hover:text-canopy-text transition-colors"
                title="Maximize"
                aria-label="Maximize"
              >
                <Maximize2 className="w-3 h-3" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={close}
                className="p-1.5 hover:bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-status-error)] focus-visible:outline-offset-2 text-canopy-text/60 hover:text-[var(--color-status-error)] transition-colors"
                title="Close assistant"
                aria-label="Close assistant"
              >
                <X className="w-3 h-3" aria-hidden="true" />
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
              aria-busy={isLoading}
            >
              <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
              <span className="flex-1 min-w-0 font-mono text-xs text-red-400 whitespace-pre-wrap break-words">
                {error}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                {messages.some((msg) => msg.role === "user") && (
                  <button
                    type="button"
                    onClick={retryLastMessage}
                    disabled={isLoading}
                    className="flex items-center gap-1.5 px-2 py-1 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-400 focus-visible:outline-offset-2"
                    aria-label={isLoading ? "Retrying last message..." : "Retry last message"}
                    title={isLoading ? "Retrying..." : "Retry last message"}
                  >
                    <RotateCw
                      className={`w-3 h-3 ${isLoading ? "animate-spin motion-reduce:animate-none" : ""}`}
                    />
                    <span>{isLoading ? "Retrying..." : "Retry"}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={clearError}
                  className="p-1.5 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-400 focus-visible:outline-offset-2"
                  aria-label="Dismiss error"
                  title="Dismiss error"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
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

      <ConfirmDialog
        isOpen={showClearDialog}
        onClose={() => setShowClearDialog(false)}
        onConfirm={handleConfirmClear}
        title="Clear conversation?"
        description="This will clear all messages in the current conversation. This action cannot be undone."
        confirmLabel="Clear"
        variant="destructive"
        isConfirmLoading={isClearing}
      />
    </div>
  );
}
