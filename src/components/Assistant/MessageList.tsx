import { useRef, useCallback, useState, useEffect } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { MessageBubble } from "./MessageBubble";
import type { AssistantMessage, StreamingState } from "./types";

interface MessageListProps {
  messages: AssistantMessage[];
  streamingState: StreamingState | null;
  className?: string;
}

export function MessageList({ messages, streamingState, className }: MessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);

  const handleAtBottomChange = useCallback(
    (bottom: boolean) => {
      setAtBottom(bottom);
      if (!bottom && autoScroll) {
        setAutoScroll(false);
      }
      if (bottom && !autoScroll) {
        setAutoScroll(true);
      }
    },
    [autoScroll]
  );

  const scrollToBottom = useCallback(() => {
    setAutoScroll(true);
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      behavior: "smooth",
    });
  }, []);

  const streamingTimestampRef = useRef<number>(Date.now());
  const isStreamingRef = useRef(false);

  useEffect(() => {
    const wasStreaming = isStreamingRef.current;
    const isStreaming = streamingState !== null;

    if (isStreaming && !wasStreaming) {
      streamingTimestampRef.current = Date.now();
    }

    isStreamingRef.current = isStreaming;
  }, [streamingState]);

  const allItems = streamingState
    ? [
        ...messages,
        {
          id: "__streaming__",
          role: "assistant" as const,
          content: streamingState.content,
          timestamp: streamingTimestampRef.current,
          toolCalls: streamingState.toolCalls,
        },
      ]
    : messages;

  const renderMessage = (index: number) => {
    const msg = allItems[index];
    const isStreaming = msg.id === "__streaming__";

    return (
      <div className="px-4 py-2">
        <MessageBubble message={msg} isStreaming={isStreaming} />
      </div>
    );
  };

  if (allItems.length === 0) {
    return (
      <div className={cn("flex-1 flex items-center justify-center", className)}>
        <div className="text-center text-canopy-text/40 px-4">
          <p className="text-sm">Start a conversation with Canopy Assistant</p>
          <p className="text-xs mt-1">Ask questions, get help with your code, or explore ideas.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex-1 relative", className)}>
      <Virtuoso
        ref={virtuosoRef}
        data={allItems}
        followOutput={autoScroll ? "smooth" : false}
        atBottomStateChange={handleAtBottomChange}
        itemContent={renderMessage}
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
          New messages
        </button>
      )}
    </div>
  );
}
