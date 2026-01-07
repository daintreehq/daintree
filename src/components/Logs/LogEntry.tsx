import { memo, useCallback } from "react";
import { cn } from "@/lib/utils";
import { safeStringify } from "@/lib/safeStringify";
import type { LogEntry as LogEntryType, LogLevel } from "@/types";

interface LogEntryProps {
  entry: LogEntryType;
  isExpanded: boolean;
  onToggle: () => void;
}

const LEVEL_COLORS: Record<LogLevel, { bg: string; text: string; border: string }> = {
  debug: {
    bg: "bg-canopy-border/20",
    text: "text-canopy-text/60",
    border: "border-canopy-border/30",
  },
  info: {
    bg: "bg-blue-500/20",
    text: "text-[var(--color-status-info)]",
    border: "border-blue-500/30",
  },
  warn: {
    bg: "bg-yellow-500/20",
    text: "text-[var(--color-status-warning)]",
    border: "border-yellow-500/30",
  },
  error: {
    bg: "bg-red-500/20",
    text: "text-[var(--color-status-error)]",
    border: "border-red-500/30",
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
        "border-b border-canopy-border/50 py-1.5 px-2",
        hasContext && "cursor-pointer hover:bg-canopy-border/30",
        isExpanded && "bg-canopy-border/20"
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
        <span
          className="text-canopy-text/60 text-xs font-mono shrink-0"
          title={new Date(entry.timestamp).toISOString()}
        >
          {formatTimestamp(entry.timestamp)}
        </span>

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
          <span className="text-purple-400 text-xs font-mono shrink-0">[{entry.source}]</span>
        )}

        <span className="text-canopy-text text-xs font-mono break-words min-w-0 flex-1">
          {entry.message}
        </span>

        {hasContext && (
          <span className="text-canopy-text/60 text-xs shrink-0">{isExpanded ? "[-]" : "[+]"}</span>
        )}
      </div>

      {isExpanded && hasContext && (
        <div
          id={contextPanelId}
          className={cn(
            "mt-2 ml-[72px] p-2 rounded border text-xs font-mono overflow-x-auto",
            colors.border,
            "bg-canopy-sidebar/50"
          )}
          role="region"
          aria-label="Log entry context"
        >
          <pre className="text-canopy-text whitespace-pre-wrap">{formatContext(entry.context!)}</pre>
        </div>
      )}
    </div>
  );
}

export const LogEntry = memo(LogEntryComponent);
