import { useRef, useCallback, useState, useEffect } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { InteractionBlock } from "./InteractionBlock";
import { EmptyState } from "./EmptyState";
import { AssistantThinkingIndicator } from "./AssistantThinkingIndicator";
import type { AssistantMessage, StreamingState } from "./types";

const LOADING_INDICATOR_DELAY_MS = 150;

interface MessageListProps {
  messages: AssistantMessage[];
  streamingState: StreamingState | null;
  streamingMessageId?: string | null;
  isLoading?: boolean;
  className?: string;
}

export function MessageList({
  messages,
  streamingState,
  streamingMessageId,
  isLoading = false,
  className,
}: MessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [showLoadingPlaceholder, setShowLoadingPlaceholder] = useState(false);

  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      behavior: "smooth",
    });
  }, []);

  const streamingTimestampRef = useRef<number>(Date.now());
  const isStreamingRef = useRef(false);
  const hasScrolledOnMount = useRef(false);

  useEffect(() => {
    const wasStreaming = isStreamingRef.current;
    const isStreaming = streamingState !== null;

    if (isStreaming && !wasStreaming) {
      streamingTimestampRef.current = Date.now();
    }

    isStreamingRef.current = isStreaming;
  }, [streamingState]);

  // Manage delayed loading indicator visibility
  useEffect(() => {
    const shouldShowLoading = isLoading && !streamingState;

    if (shouldShowLoading) {
      const timerId = setTimeout(() => {
        setShowLoadingPlaceholder(true);
      }, LOADING_INDICATOR_DELAY_MS);

      return () => {
        clearTimeout(timerId);
      };
    }

    setShowLoadingPlaceholder(false);
    return undefined;
  }, [isLoading, streamingState]);

  // Scroll to bottom on mount when messages exist (handles panel drag/remount)
  useEffect(() => {
    if (!hasScrolledOnMount.current && messages.length > 0) {
      hasScrolledOnMount.current = true;
      virtuosoRef.current?.scrollToIndex({
        index: "LAST",
        behavior: "auto",
      });
    }
  }, [messages.length]);

  // Create streaming item with a dynamic key that changes when tool calls are added/updated.
  // This ensures Virtuoso detects the change and re-renders the streaming item.
  // We compute a version from tool call count + status to catch both additions and status changes.
  // Without this, Virtuoso may optimize away re-renders for items with stable keys,
  // causing tool-call-only responses to not display during streaming.
  const streamingKey = streamingState
    ? `__streaming__:${streamingState.toolCalls.length}:${streamingState.toolCalls.map((tc) => tc.status).join(",")}`
    : null;

  const visibleMessages =
    streamingMessageId && streamingState
      ? messages.filter((msg) => msg.id !== streamingMessageId)
      : messages;

  const allItems = streamingState
    ? [
        ...visibleMessages,
        {
          id: streamingKey!,
          role: "assistant" as const,
          content: streamingState.content,
          timestamp: streamingTimestampRef.current,
          toolCalls: streamingState.toolCalls,
        },
      ]
    : showLoadingPlaceholder
      ? [
          ...messages,
          {
            id: "__loading__",
            role: "assistant" as const,
            content: "",
            timestamp: Date.now(),
          },
        ]
      : messages;

  const renderMessage = (_index: number, msg: AssistantMessage) => {
    if (msg.id === "__loading__") {
      return <AssistantThinkingIndicator />;
    }

    const isStreaming = msg.id.startsWith("__streaming__");

    return <InteractionBlock message={msg} isStreaming={isStreaming} />;
  };

  const computeItemKey = useCallback((_index: number, item: AssistantMessage) => item.id, []);

  if (allItems.length === 0) {
    return <EmptyState className={cn("flex-1", className)} />;
  }

  return (
    <div className={cn("flex-1 relative font-mono text-sm", className)}>
      <Virtuoso
        ref={virtuosoRef}
        data={allItems}
        followOutput="smooth"
        atBottomStateChange={setAtBottom}
        itemContent={renderMessage}
        computeItemKey={computeItemKey}
        className="h-full"
        initialTopMostItemIndex={allItems.length - 1}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
      />

      {!atBottom && allItems.length > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          className={cn(
            "absolute bottom-4 right-4",
            "flex items-center gap-1.5 px-3 py-1.5",
            "bg-canopy-accent text-white text-xs font-medium",
            "rounded-full shadow-lg",
            "hover:bg-canopy-accent/90 transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-canopy-accent/50"
          )}
        >
          <ArrowDown className="w-3.5 h-3.5" />
          New output
        </button>
      )}
    </div>
  );
}
