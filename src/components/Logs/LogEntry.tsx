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
  info: "bg-status-info/25 text-text-primary",
  warn: "bg-status-warning/25 text-text-primary",
  error: "bg-status-error/25 text-text-primary",
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

  const handleCopy = useCallback(
    async () => {
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

  const summary = (
    <>
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
        <span className="text-text-secondary text-xs font-mono shrink-0 tabular-nums bg-overlay-soft px-1.5 rounded-[var(--radius-sm)]">
          ×{count}
        </span>
      )}

      {hasContext && (
        <span className="text-text-secondary shrink-0" aria-hidden>
          {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </span>
      )}
    </>
  );

  // Level, source and repeat count belong in the name: they're what a
  // sighted reader scans the row for.
  const accessibleName = [
    entry.level.toUpperCase(),
    entry.source ? `from ${entry.source}:` : null,
    entry.message,
    count > 1 ? `(repeated ${count} times)` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={cn(
        "group border-b border-divider py-1 px-3 relative",
        hasContext && "hover:bg-overlay-subtle",
        isExpanded && "bg-overlay-subtle"
      )}
    >
      <div className="flex items-start gap-2 min-w-0">
        {hasContext ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-controls={contextPanelId}
            aria-label={accessibleName}
            className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-[var(--radius-sm)] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
          >
            {summary}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-2">{summary}</div>
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
