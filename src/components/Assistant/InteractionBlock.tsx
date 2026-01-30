import { useState, useCallback, useEffect } from "react";
import { Terminal, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { CanopyIcon } from "@/components/icons/CanopyIcon";
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
        "group relative flex w-full gap-3 px-4 py-2 border-l-2 border-canopy-accent/30",
        className
      )}
      role="article"
      aria-label="User input"
    >
      <div className="shrink-0 text-canopy-accent/60 pt-[2px]" aria-hidden="true">
        <Terminal className="w-3.5 h-3.5" />
      </div>
      <div className="prose-sm font-mono text-sm leading-relaxed text-canopy-text/90 w-full break-words whitespace-pre-wrap select-text">
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

  // Clean up copied state timeout on unmount
  useEffect(() => {
    if (!copied) return;
    const timeoutId = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeoutId);
  }, [copied]);

  return (
    <div
      className={cn(
        "group flex w-full gap-3 px-4 py-4 border-b border-divider/20 hover:bg-white/[0.01] transition-colors",
        className
      )}
      role="article"
      aria-label="Assistant response"
    >
      <div className="shrink-0 pt-[3px]" aria-hidden="true">
        <CanopyIcon size={14} className="text-canopy-text/40" />
      </div>
      <div className="flex-1 min-w-0 space-y-3 select-text">
        {hasToolCalls && (
          <div className="flex flex-col gap-1">
            {message.toolCalls!.map((tc) => (
              <ToolCallBlock key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {(hasContent || (isStreaming && !hasToolCalls)) && (
          <div>
            <MarkdownRenderer
              content={message.content}
              className="text-canopy-text text-sm leading-6 font-normal"
            />
            {isStreaming && <StreamingCursor />}
          </div>
        )}

        {isStreaming && hasToolCalls && !hasContent && <StreamingCursor className="ml-0" />}

        {!hasContent && !hasToolCalls && !isStreaming && (
          <div className="text-canopy-text/40 text-sm italic">No response content</div>
        )}

        {/* Copy button - positioned at bottom of content area */}
        {hasContent && !isStreaming && (
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={handleCopy}
              className={cn(
                "flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium",
                "opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
                "[@media(hover:none)]:opacity-100",
                copied
                  ? "text-green-400 bg-green-400/10"
                  : "text-canopy-text/50 hover:text-canopy-text/80 hover:bg-canopy-bg/50"
              )}
              aria-label={copied ? "Copied response" : "Copy response"}
              title="Copy response to clipboard"
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  Copy
                </>
              )}
            </button>
          </div>
        )}
      </div>
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
