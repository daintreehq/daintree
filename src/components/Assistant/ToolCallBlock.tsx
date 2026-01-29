import { useState, useCallback } from "react";
import { Loader2, CheckCircle, XCircle, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolCall } from "./types";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface ToolCallBlockProps {
  toolCall: ToolCall;
  className?: string;
}

export function ToolCallBlock({ toolCall, className }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleExpanded();
      }
    },
    [toggleExpanded]
  );

  const StatusIcon = () => {
    switch (toolCall.status) {
      case "pending":
        return <Loader2 className="w-3.5 h-3.5 text-canopy-text/50 animate-spin" />;
      case "success":
        return <CheckCircle className="w-3.5 h-3.5 text-green-400" />;
      case "error":
        return <XCircle className="w-3.5 h-3.5 text-red-400" />;
    }
  };

  return (
    <div className={cn("mt-2 border border-canopy-border rounded-md overflow-hidden", className)}>
      <button
        type="button"
        onClick={toggleExpanded}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2",
          "bg-canopy-sidebar/50 text-sm",
          "hover:bg-canopy-sidebar/70 transition-colors",
          "focus:outline-none focus:ring-1 focus:ring-canopy-accent/50"
        )}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-canopy-text/50" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-canopy-text/50" />
        )}
        <Wrench className="w-3.5 h-3.5 text-blue-400" />
        <span className="text-canopy-text/80 font-mono text-xs">{toolCall.name}</span>
        <span className="ml-auto">
          <StatusIcon />
        </span>
      </button>

      {expanded && (
        <div className="px-3 py-2 text-xs font-mono text-canopy-text/60 bg-canopy-bg/50 border-t border-canopy-border">
          <div className="mb-1 text-canopy-text/40 text-[10px] uppercase tracking-wider">
            Arguments
          </div>
          <pre className="whitespace-pre-wrap break-all overflow-x-auto">
            {safeStringify(toolCall.args)}
          </pre>

          {toolCall.result !== undefined && (
            <>
              <hr className="my-2 border-canopy-border" />
              <div className="mb-1 text-canopy-text/40 text-[10px] uppercase tracking-wider">
                Result
              </div>
              <pre className="whitespace-pre-wrap break-all overflow-x-auto">
                {typeof toolCall.result === "string"
                  ? toolCall.result
                  : safeStringify(toolCall.result)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
