import { useState, useCallback } from "react";
import { CheckCircle2, XCircle, ChevronDown, ChevronRight } from "lucide-react";
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
          <div className="w-5 h-5 rounded-full flex items-center justify-center bg-blue-500/10">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          </div>
        );
      case "success":
        return (
          <div className="w-5 h-5 rounded-full flex items-center justify-center bg-canopy-accent/10 text-canopy-accent">
            <CheckCircle2 size={12} />
          </div>
        );
      case "error":
        return (
          <div className="w-5 h-5 rounded-full flex items-center justify-center bg-red-500/10 text-red-400">
            <XCircle size={12} />
          </div>
        );
      default:
        return (
          <div className="w-5 h-5 rounded-full flex items-center justify-center bg-canopy-sidebar/50">
            <span className="w-2 h-2 rounded-full bg-canopy-text/30" />
          </div>
        );
    }
  };

  const getStatusBadge = () => {
    switch (toolCall.status) {
      case "pending":
        return (
          <span className="text-[10px] uppercase tracking-wider font-medium text-blue-400">
            Running
          </span>
        );
      case "success":
        return (
          <span className="text-[10px] uppercase tracking-wider font-medium text-canopy-accent">
            Success
          </span>
        );
      case "error":
        return (
          <span className="text-[10px] uppercase tracking-wider font-medium text-red-400">
            Error
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className={cn("overflow-hidden", className)}>
      <button
        type="button"
        onClick={toggleExpanded}
        className={cn(
          "flex items-center justify-between gap-3 px-3 py-2 rounded border border-canopy-border w-full max-w-[520px]",
          "group hover:border-canopy-text/20 transition-colors cursor-pointer bg-canopy-sidebar/30",
          "focus:outline-none focus:ring-1 focus:ring-canopy-accent/30"
        )}
        aria-expanded={expanded}
        aria-controls={`tool-call-details-${toolCall.id}`}
      >
        <div className="flex items-center gap-3">
          {getStatusIndicator()}
          <span className="text-[13px] text-canopy-text/60 font-mono group-hover:text-canopy-text/80 transition-colors">
            {toolCall.name}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {getStatusBadge()}
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-canopy-text/40 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-canopy-text/40 shrink-0" />
          )}
        </div>
      </button>

      {expanded && (
        <div
          id={`tool-call-details-${toolCall.id}`}
          className="px-3 py-3 mt-1 text-[13px] font-mono text-canopy-text/60 bg-canopy-sidebar/20 rounded border border-canopy-border max-w-[520px]"
        >
          <div className="mb-1.5 text-canopy-text/40 text-[10px] uppercase tracking-wider font-medium">
            Arguments
          </div>
          <pre className="whitespace-pre-wrap break-all overflow-x-auto bg-canopy-bg/50 rounded p-2 text-[11px] leading-relaxed text-canopy-text/60">
            {safeStringify(toolCall.args)}
          </pre>

          {toolCall.status === "error" && toolCall.error && (
            <>
              <div className="mt-3 mb-1.5 text-canopy-text/40 text-[10px] uppercase tracking-wider font-semibold">
                Error
              </div>
              <pre className="whitespace-pre-wrap break-all overflow-x-auto bg-red-500/10 border border-red-500/20 rounded p-2 text-[11px] leading-relaxed text-red-400">
                {toolCall.error}
              </pre>
            </>
          )}

          {toolCall.result !== undefined && (
            <>
              <div className="mt-3 mb-1.5 text-canopy-text/40 text-[10px] uppercase tracking-wider font-semibold">
                Result
              </div>
              <pre className="whitespace-pre-wrap break-all overflow-x-auto bg-canopy-bg/50 rounded p-2 text-[11px] leading-relaxed text-canopy-text/60">
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
