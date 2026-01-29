import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ToolCallBlock } from "./ToolCallBlock";
import { StreamingCursor } from "./StreamingCursor";
import type { AssistantMessage } from "./types";

interface MessageBubbleProps {
  message: Pick<AssistantMessage, "role" | "content" | "toolCalls">;
  isStreaming?: boolean;
  className?: string;
}

export function MessageBubble({ message, isStreaming = false, className }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div
      className={cn(
        "rounded-lg px-4 py-3 max-w-[85%]",
        isUser ? "bg-canopy-accent/15 ml-auto" : "bg-canopy-sidebar/60",
        className
      )}
    >
      {isUser ? (
        <p className="text-canopy-text text-sm whitespace-pre-wrap">{message.content}</p>
      ) : (
        <>
          <MarkdownRenderer content={message.content} />
          {isStreaming && <StreamingCursor />}
        </>
      )}

      {message.toolCalls?.map((tc) => (
        <ToolCallBlock key={tc.id} toolCall={tc} />
      ))}
    </div>
  );
}
