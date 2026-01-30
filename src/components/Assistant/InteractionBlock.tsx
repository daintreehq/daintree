import { Terminal } from "lucide-react";
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

export function InteractionBlock({
  message,
  isStreaming = false,
  className,
}: InteractionBlockProps) {
  if (message.role === "user") {
    return (
      <div
        className={cn(
          "group relative flex w-full gap-3 bg-canopy-sidebar/30 px-4 py-3 border-b border-divider/40",
          className
        )}
        role="log"
        aria-label="User input"
      >
        <div className="shrink-0 text-canopy-accent pt-[2px]" aria-hidden="true">
          <Terminal className="w-3.5 h-3.5" />
        </div>
        <div className="prose-sm font-mono text-sm leading-relaxed text-canopy-text/90 w-full break-words whitespace-pre-wrap">
          {message.content}
        </div>
        <div
          className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 text-[10px] text-canopy-text/30 transition-opacity"
          aria-hidden="true"
        >
          INPUT
        </div>
      </div>
    );
  }

  const hasContent = message.content && message.content.trim().length > 0;
  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;

  return (
    <div
      className={cn(
        "flex w-full gap-3 px-4 py-4 border-b border-divider/20 hover:bg-white/[0.01] transition-colors",
        className
      )}
      role="log"
      aria-label="Assistant response"
    >
      <div className="shrink-0 pt-[3px]" aria-hidden="true">
        <CanopyIcon size={14} className="text-canopy-text/40" />
      </div>
      <div className="flex-1 min-w-0 space-y-3">
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
      </div>
    </div>
  );
}
