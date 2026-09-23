import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Check, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { safeStringify } from "@/lib/safeStringify";
import { sanitizeErrorText } from "@/utils/errorText";
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

// The level word carries the meaning; the tint only helps the eye group rows.
// Text stays neutral because status-coloured text fails contrast on most themes.
const LEVEL_CHIP: Record<LogLevel, string> = {
  debug: "bg-overlay-soft text-text-secondary",
  info: "bg-status-info/15 text-text-primary",
  warn: "bg-status-warning/20 text-text-primary",
  error: "bg-status-error/20 text-text-primary",
};

const LEVEL_EDGE: Record<LogLevel, string> = {
  debug: "border-l-border-strong",
  info: "border-l-status-info",
  warn: "border-l-status-warning",
  error: "border-l-status-error",
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
  const safeSource = entry.source ? sanitizeErrorText(entry.source) : "";
  const headLine = safeSource
    ? `[${iso}] [${entry.level.toUpperCase()}] [${safeSource}]`
    : `[${iso}] [${entry.level.toUpperCase()}]`;
  const body = [headLine, sanitizeErrorText(entry.message)];
  if (entry.context && Object.keys(entry.context).length > 0) {
    body.push(sanitizeErrorText(safeStringify(entry.context, 2)));
  }
  // Use tilde fence so any backtick blocks inside the log body don't break the outer fence.
  return `${header}~~~log\n${body.join("\n")}\n~~~`;
}

export function LogEntry({ entry, isExpanded, onToggle, count = 1, copyMeta }: LogEntryProps) {
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
        "group border-b border-divider py-1 px-3 relative",
        hasContext && "cursor-pointer hover:bg-overlay-subtle",
        isExpanded && "bg-overlay-subtle"
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
            <span className="text-text-secondary text-xs font-mono shrink-0">
              {formatTimestamp(entry.timestamp)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{new Date(entry.timestamp).toISOString()}</TooltipContent>
        </Tooltip>

        <span
          className={cn(
            "w-11 shrink-0 rounded-[var(--radius-sm)] py-px text-center text-2xs font-medium uppercase",
            LEVEL_CHIP[entry.level]
          )}
        >
          {entry.level}
        </span>

        {entry.source && (
          <span className="text-text-secondary text-xs font-mono shrink-0">[{entry.source}]</span>
        )}

        <span className="text-text-primary text-xs font-mono break-words min-w-0 flex-1">
          {entry.message}
        </span>

        {count > 1 && (
          <span
            className="text-text-secondary text-xs font-mono shrink-0 tabular-nums bg-overlay-soft px-1.5 rounded-[var(--radius-sm)]"
            aria-label={`Repeated ${count} times`}
          >
            ×{count}
          </span>
        )}

        {hasContext && (
          <span className="text-text-secondary shrink-0" aria-hidden>
            {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </span>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleCopy}
              // Enter/Space on Copy would otherwise bubble to the row and
              // toggle its context as well as copying.
              onKeyDown={(e) => e.stopPropagation()}
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
            "mt-1.5 mb-1 ml-[7.25rem] p-2 rounded-[var(--radius-md)] border border-l-2 text-xs font-mono overflow-x-auto bg-surface-canvas border-divider",
            LEVEL_EDGE[entry.level]
          )}
          role="region"
          aria-label="Log entry context"
        >
          <pre className="text-text-primary whitespace-pre-wrap select-text">{formatContext(entry.context!)}</pre>
        </div>
      )}
    </div>
  );
}
