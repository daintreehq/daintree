import { useEffect, useRef, useCallback } from "react";
import { Loader2, XCircle, X } from "lucide-react";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { useAppAgentStore } from "@/store";
import { MessageList } from "./MessageList";
import { AssistantInput, type AssistantInputHandle } from "./AssistantInput";
import { EmptyState } from "./EmptyState";
import { useAssistantChat } from "./useAssistantChat";

export type AssistantPaneProps = BasePanelProps;

export function AssistantPane({
  id,
  title,
  isFocused,
  isMaximized = false,
  location = "grid",
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  isTrashing = false,
  gridPanelCount,
}: AssistantPaneProps) {
  const { hasApiKey, isInitialized, initialize } = useAppAgentStore();
  const inputRef = useRef<AssistantInputHandle>(null);

  const {
    messages,
    streamingState,
    isLoading,
    error,
    sendMessage,
    cancelStreaming,
    clearError,
    clearMessages,
  } = useAssistantChat({ panelId: id });

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    if (isFocused) {
      inputRef.current?.focus();
    }
  }, [isFocused]);

  const handleSubmit = useCallback(
    (value: string) => {
      sendMessage(value);
      inputRef.current?.focus();
    },
    [sendMessage]
  );

  const handleFocus = useCallback(() => {
    onFocus?.();
    inputRef.current?.focus();
  }, [onFocus]);

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
    <ContentPanel
      id={id}
      title={title}
      kind="assistant"
      isFocused={isFocused}
      isMaximized={isMaximized}
      location={location}
      isTrashing={isTrashing}
      gridPanelCount={gridPanelCount}
      onFocus={handleFocus}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleChange={onTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
      onRestart={showChat && hasMessages ? handleClearConversation : undefined}
    >
      <div className="flex flex-col h-full bg-canopy-bg">
        {showLoading && (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-6 h-6 text-canopy-text/40 animate-spin" />
          </div>
        )}

        {showNoApiKey && <EmptyState />}

        {showChat && (
          <>
            {hasMessages ? (
              <MessageList
                messages={messages}
                streamingState={streamingState}
                className="flex-1 min-h-0"
              />
            ) : (
              <EmptyState onSubmit={handleSubmit} />
            )}

            {error && (
              <div
                className="flex items-start gap-3 px-3 py-2 border-l-2 border-red-500 bg-red-500/5"
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
              isStreaming={isLoading && !!streamingState}
              disabled={isLoading}
              placeholder="Execute a command or ask a question..."
            />
          </>
        )}
      </div>
    </ContentPanel>
  );
}
