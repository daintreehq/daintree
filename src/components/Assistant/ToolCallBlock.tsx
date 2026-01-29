import { useState, useCallback } from "react";
import { CheckCircle, XCircle, ChevronDown, ChevronRight } from "lucide-react";
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

  const getStatusIndicator = () => {
    switch (toolCall.status) {
      case "pending":
        return (
          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse inline-block shrink-0" />
        );
      case "success":
        return <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />;
      case "error":
        return <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />;
      default:
        return <span className="w-2 h-2 rounded-full bg-canopy-text/30 inline-block shrink-0" />;
    }
  };

  const getStatusText = () => {
    switch (toolCall.status) {
      case "pending":
        return `⟳ ${toolCall.name}...`;
      case "success":
        return `✓ ${toolCall.name}`;
      case "error":
        return `✗ ${toolCall.name}`;
      default:
        return toolCall.name;
    }
  };

  const getBorderColor = () => {
    switch (toolCall.status) {
      case "pending":
        return "border-l-blue-500/50";
      case "success":
        return "border-l-green-500/50";
      case "error":
        return "border-l-red-500/50";
      default:
        return "border-l-canopy-text/20";
    }
  };

  const getBackgroundColor = () => {
    switch (toolCall.status) {
      case "pending":
        return "bg-blue-500/5";
      case "success":
        return "bg-green-500/5";
      case "error":
        return "bg-red-500/5";
      default:
        return "bg-canopy-sidebar/20";
    }
  };

  return (
    <div className={cn("overflow-hidden", className)}>
      <button
        type="button"
        onClick={toggleExpanded}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2",
          "border-l-2 transition-colors",
          getBorderColor(),
          getBackgroundColor(),
          "hover:bg-white/[0.02]",
          "focus:outline-none focus:ring-1 focus:ring-canopy-accent/30"
        )}
        aria-expanded={expanded}
        aria-controls={`tool-call-details-${toolCall.id}`}
      >
        {getStatusIndicator()}
        <span className="flex-1 text-left font-mono text-xs text-canopy-text/70">
          {getStatusText()}
        </span>
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-canopy-text/40 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-canopy-text/40 shrink-0" />
        )}
      </button>

      {expanded && (
        <div
          id={`tool-call-details-${toolCall.id}`}
          className="px-3 py-3 text-xs font-mono text-canopy-text/70 bg-canopy-bg/30 border-l-2 border-l-transparent ml-[1px]"
        >
          <div className="mb-1.5 text-canopy-text/50 text-[10px] uppercase tracking-wider font-semibold">
            Arguments
          </div>
          <pre className="whitespace-pre-wrap break-all overflow-x-auto bg-canopy-sidebar/30 rounded p-2 text-[11px] leading-relaxed">
            {safeStringify(toolCall.args)}
          </pre>

          {toolCall.status === "error" && toolCall.error && (
            <>
              <div className="mt-3 mb-1.5 text-canopy-text/50 text-[10px] uppercase tracking-wider font-semibold">
                Error
              </div>
              <pre className="whitespace-pre-wrap break-all overflow-x-auto bg-red-500/10 border border-red-500/20 rounded p-2 text-[11px] leading-relaxed text-red-400">
                {toolCall.error}
              </pre>
            </>
          )}

          {toolCall.result !== undefined && (
            <>
              <div className="mt-3 mb-1.5 text-canopy-text/50 text-[10px] uppercase tracking-wider font-semibold">
                Result
              </div>
              <pre className="whitespace-pre-wrap break-all overflow-x-auto bg-canopy-sidebar/30 rounded p-2 text-[11px] leading-relaxed">
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
