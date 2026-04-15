import { memo, useCallback } from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { safeStringify } from "@/lib/safeStringify";
import type { LogEntry as LogEntryType, LogLevel } from "@/types";

interface LogEntryProps {
  entry: LogEntryType;
  isExpanded: boolean;
  onToggle: () => void;
}

const LEVEL_COLORS: Record<LogLevel, { bg: string; text: string; border: string }> = {
  debug: {
    bg: "bg-daintree-border/20",
    text: "text-daintree-text/60",
    border: "border-daintree-border/30",
  },
  info: {
    bg: "bg-status-info/20",
    text: "text-status-info",
    border: "border-status-info/30",
  },
  warn: {
    bg: "bg-status-warning/20",
    text: "text-status-warning",
    border: "border-status-warning/30",
  },
  error: {
    bg: "bg-status-error/20",
    text: "text-status-error",
    border: "border-status-error/30",
  },
};

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatContext(context: Record<string, unknown>): string {
  return safeStringify(context, 2);
}

function LogEntryComponent({ entry, isExpanded, onToggle }: LogEntryProps) {
  const colors = LEVEL_COLORS[entry.level];
  const hasContext = entry.context && Object.keys(entry.context).length > 0;
  const contextPanelId = hasContext ? `context-${entry.id}` : undefined;

  const handleClick = useCallback(() => {
    if (hasContext) {
      onToggle();
    }
  }, [hasContext, onToggle]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (hasContext && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        onToggle();
      }
    },
    [hasContext, onToggle]
  );

  return (
    <div
      className={cn(
        "border-b border-daintree-border/50 py-1.5 px-2",
        hasContext && "cursor-pointer hover:bg-daintree-border/30",
        isExpanded && "bg-daintree-border/20"
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role={hasContext ? "button" : undefined}
      tabIndex={hasContext ? 0 : undefined}
      aria-expanded={hasContext ? isExpanded : undefined}
      aria-controls={contextPanelId}
      aria-label={
        hasContext
          ? `Log entry: ${entry.message}. Press to ${isExpanded ? "collapse" : "expand"} context.`
          : undefined
      }
    >
      <div className="flex items-start gap-2 min-w-0">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-daintree-text/60 text-xs font-mono shrink-0">
                {formatTimestamp(entry.timestamp)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{new Date(entry.timestamp).toISOString()}</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <span
          className={cn(
            "text-xs font-medium px-1.5 py-0.5 rounded shrink-0 uppercase",
            colors.bg,
            colors.text
          )}
        >
          {entry.level}
        </span>

        {entry.source && (
          <span className="text-github-merged text-xs font-mono shrink-0">[{entry.source}]</span>
        )}

        <span className="text-daintree-text text-xs font-mono break-words min-w-0 flex-1">
          {entry.message}
        </span>

        {hasContext && (
          <span className="text-daintree-text/60 text-xs shrink-0">{isExpanded ? "[-]" : "[+]"}</span>
        )}
      </div>

      {isExpanded && hasContext && (
        <div
          id={contextPanelId}
          className={cn(
            "mt-2 ml-[72px] p-2 rounded border text-xs font-mono overflow-x-auto",
            colors.border,
            "bg-daintree-sidebar/50"
          )}
          role="region"
          aria-label="Log entry context"
        >
          <pre className="text-daintree-text whitespace-pre-wrap select-text">{formatContext(entry.context!)}</pre>
        </div>
      )}
    </div>
  );
}

export const LogEntry = memo(LogEntryComponent);
