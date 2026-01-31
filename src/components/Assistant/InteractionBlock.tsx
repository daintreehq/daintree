import { useState, useCallback, useEffect } from "react";
import { ChevronRight, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ToolCallBlock } from "./ToolCallBlock";
import { StreamingCursor } from "./StreamingCursor";
import type { AssistantMessage } from "./types";

interface InteractionBlockProps {
  message: Pick<AssistantMessage, "role" | "content" | "toolCalls" | "timestamp">;
  isStreaming?: boolean;
  className?: string;
}

function UserInputBlock({ content, className }: { content: string; className?: string }) {
  return (
    <div
      className={cn(
        "group flex gap-5 px-5 py-3",
        "bg-canopy-sidebar/25 border-y border-divider/60",
        className
      )}
      role="article"
      aria-label="User input"
    >
      <div className="mt-0.5 text-canopy-text/40 shrink-0 select-none" aria-hidden="true">
        <ChevronRight size={16} />
      </div>
      <div className="text-canopy-text font-medium font-mono text-[14px] leading-[1.6] break-words whitespace-pre-wrap select-text">
        {content}
      </div>
    </div>
  );
}

function AssistantResponseBlock({
  message,
  isStreaming,
  className,
}: {
  message: Pick<AssistantMessage, "content" | "toolCalls">;
  isStreaming: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const hasContent = message.content && message.content.trim().length > 0;
  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard?.writeText) {
      console.warn("Clipboard API not available");
      return;
    }

    const textToCopy = message.content || "";
    if (!textToCopy.trim()) return;

    navigator.clipboard
      .writeText(textToCopy)
      .then(() => {
        setCopied(true);
      })
      .catch((err) => {
        console.error("Failed to copy to clipboard:", err);
      });
  }, [message.content]);

  useEffect(() => {
    if (!copied) return;
    const timeoutId = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeoutId);
  }, [copied]);

  return (
    <div
      className={cn("group pl-14 pr-5 py-3 space-y-3 relative", className)}
      role="article"
      aria-label="Assistant response"
    >
      {/* Thread line - extends through full padding box */}
      <div className="absolute left-7 top-0 bottom-0 w-px bg-canopy-border" />

      {hasToolCalls && (
        <div className="space-y-2">
          {message.toolCalls!.map((tc) => (
            <ToolCallBlock key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}

      {(hasContent || (isStreaming && !hasToolCalls)) && (
        <div>
          <MarkdownRenderer content={message.content} />
          {isStreaming && <StreamingCursor />}
        </div>
      )}

      {isStreaming && hasToolCalls && !hasContent && <StreamingCursor className="ml-0" />}

      {!hasContent && !hasToolCalls && !isStreaming && (
        <div className="text-canopy-text/40 text-sm italic">No response content</div>
      )}

      {/* Copy button - bottom right */}
      {hasContent && !isStreaming && (
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            "absolute bottom-3 right-5 p-1.5 rounded transition-all",
            "opacity-0 group-hover:opacity-100 focus:opacity-100",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
            "[@media(hover:none)]:opacity-100",
            copied
              ? "text-canopy-accent bg-canopy-accent/10"
              : "text-canopy-text/30 hover:text-canopy-text/60 hover:bg-canopy-sidebar/40"
          )}
          aria-label={copied ? "Copied response" : "Copy response"}
          title="Copy response to clipboard"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      )}
    </div>
  );
}

export function InteractionBlock({
  message,
  isStreaming = false,
  className,
}: InteractionBlockProps) {
  if (message.role === "user") {
    return <UserInputBlock content={message.content} className={className} />;
  }

  return (
    <AssistantResponseBlock message={message} isStreaming={isStreaming} className={className} />
  );
}
