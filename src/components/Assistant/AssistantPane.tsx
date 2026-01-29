import { useEffect, useRef, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { useAppAgentStore } from "@/store";
import { cn } from "@/lib/utils";
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

  const { messages, streamingState, isLoading, error, sendMessage, cancelStreaming, clearError } =
    useAssistantChat();

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
    },
    [sendMessage]
  );

  const handleFocus = useCallback(() => {
    onFocus?.();
    inputRef.current?.focus();
  }, [onFocus]);

  const showLoading = !isInitialized;
  const showEmptyState = isInitialized && !hasApiKey;
  const showChat = isInitialized && hasApiKey;

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
    >
      <div className="flex flex-col h-full bg-canopy-bg">
        {showLoading && (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-6 h-6 text-canopy-text/40 animate-spin" />
          </div>
        )}

        {showEmptyState && <EmptyState />}

        {showChat && (
          <>
            <MessageList
              messages={messages}
              streamingState={streamingState}
              className="flex-1 min-h-0"
            />

            {error && (
              <div
                className={cn(
                  "mx-4 mb-2 px-3 py-2 rounded-md",
                  "bg-red-500/10 border border-red-500/20",
                  "text-red-400 text-sm"
                )}
                role="alert"
              >
                <div className="flex items-center justify-between">
                  <span>{error}</span>
                  <button
                    type="button"
                    onClick={clearError}
                    className="text-red-400/70 hover:text-red-400 text-xs"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {isLoading && streamingState && (
              <div className="px-4 pb-2">
                <button
                  type="button"
                  onClick={cancelStreaming}
                  className={cn(
                    "text-xs text-canopy-text/50 hover:text-canopy-text/70",
                    "transition-colors"
                  )}
                >
                  Cancel response
                </button>
              </div>
            )}

            <AssistantInput
              ref={inputRef}
              onSubmit={handleSubmit}
              disabled={isLoading}
              placeholder={isLoading ? "Assistant is typing..." : "Ask the assistant..."}
            />
          </>
        )}
      </div>
    </ContentPanel>
  );
}
