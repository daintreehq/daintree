import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { safeStringify } from "@/lib/safeStringify";
import type { LogEntry as LogEntryType, LogLevel } from "@/types";

export interface LogEntryCopyMeta {
  appVersion: string;
  electronVersion: string;
  platform: string;
}

interface LogEntryProps {
  entry: LogEntryType;
  isExpanded: boolean;
  onToggle: () => void;
  count?: number;
  copyMeta?: LogEntryCopyMeta;
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

function buildCopyPayload(entry: LogEntryType, meta?: LogEntryCopyMeta): string {
  const iso = new Date(entry.timestamp).toISOString();
  const header = meta
    ? `App: ${meta.appVersion} | Electron: ${meta.electronVersion} | OS: ${meta.platform}\n\n`
    : "";
  const headLine = entry.source
    ? `[${iso}] [${entry.level.toUpperCase()}] [${entry.source}]`
    : `[${iso}] [${entry.level.toUpperCase()}]`;
  const body = [headLine, entry.message];
  if (entry.context && Object.keys(entry.context).length > 0) {
    body.push(safeStringify(entry.context, 2));
  }
  // Use tilde fence so any backtick blocks inside the log body don't break the outer fence.
  return `${header}~~~log\n${body.join("\n")}\n~~~`;
}

function LogEntryComponent({ entry, isExpanded, onToggle, count = 1, copyMeta }: LogEntryProps) {
  const colors = LEVEL_COLORS[entry.level];
  const hasContext = entry.context && Object.keys(entry.context).length > 0;
  const contextPanelId = hasContext ? `context-${entry.id}` : undefined;

  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
    };
  }, []);

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

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(buildCopyPayload(entry, copyMeta));
        setCopied(true);
        if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = setTimeout(() => {
          setCopied(false);
          copyTimeoutRef.current = null;
        }, 1500);
      } catch {
        // clipboard write can reject in unusual contexts; swallow silently
      }
    },
    [entry, copyMeta]
  );

  return (
    <div
      className={cn(
        "group border-b border-daintree-border/50 py-1.5 px-2 relative",
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
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-daintree-text/60 text-xs font-mono shrink-0">
              {formatTimestamp(entry.timestamp)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{new Date(entry.timestamp).toISOString()}</TooltipContent>
        </Tooltip>

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

        {count > 1 && (
          <span
            className="text-daintree-text/60 text-xs font-mono shrink-0 tabular-nums bg-daintree-border/30 px-1.5 rounded"
            aria-label={`Repeated ${count} times`}
          >
            ×{count}
          </span>
        )}

        {hasContext && (
          <span className="text-daintree-text/60 text-xs shrink-0">{isExpanded ? "[-]" : "[+]"}</span>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleCopy}
              aria-label={copied ? "Copied" : "Copy log entry"}
              className={cn(
                "h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                copied && "opacity-100"
              )}
            >
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{copied ? "Copied" : "Copy entry"}</TooltipContent>
        </Tooltip>
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
