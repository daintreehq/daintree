import { User, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ToolCallBlock } from "./ToolCallBlock";
import { StreamingCursor } from "./StreamingCursor";
import type { AssistantMessage } from "./types";

interface MessageBubbleProps {
  message: Pick<AssistantMessage, "role" | "content" | "toolCalls" | "timestamp">;
  isStreaming?: boolean;
  className?: string;
}

function formatTimestamp(timestamp: number): string {
  if (!timestamp || timestamp <= 0) return "";

  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return "";

  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function MessageBubble({ message, isStreaming = false, className }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex flex-col gap-2 w-full", className)}>
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex items-center justify-center w-6 h-6 rounded-md shrink-0",
            isUser ? "bg-canopy-accent/20 text-canopy-accent" : "bg-blue-500/20 text-blue-400"
          )}
        >
          {isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
        </div>
        <span
          className={cn("text-xs font-medium", isUser ? "text-canopy-accent" : "text-blue-400")}
        >
          {isUser ? "You" : "Assistant"}
        </span>
        <span className="text-[10px] text-canopy-text/30 ml-auto">
          {formatTimestamp(message.timestamp)}
        </span>
      </div>

      <div className="pl-8">
        {isUser ? (
          <p className="text-canopy-text text-sm whitespace-pre-wrap leading-relaxed">
            {message.content}
          </p>
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
    </div>
  );
}
