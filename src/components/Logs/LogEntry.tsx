import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/ui/CopyButton";
import { Badge, CountBadge } from "@/components/ui/badge";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
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
  debug: "bg-tint/10 text-text-secondary",
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

function buildCopyPayload(entry: LogEntryType, count: number, meta?: LogEntryCopyMeta): string {
  const iso = new Date(entry.timestamp).toISOString();
  const header = meta
    ? `App: ${meta.appVersion} | Electron: ${meta.electronVersion} | OS: ${meta.platform}\n\n`
    : "";
  const safeSource = entry.source ? sanitizeErrorText(entry.source) : "";
  const headLine = safeSource
    ? `[${iso}] [${entry.level.toUpperCase()}] [${safeSource}]`
    : `[${iso}] [${entry.level.toUpperCase()}]`;
  const body = [headLine, sanitizeErrorText(entry.message)];
  // A collapsed burst pasted as one line would read as a single occurrence.
  if (count > 1) body.push(`(repeated ${count} times)`);
  if (entry.context && Object.keys(entry.context).length > 0) {
    body.push(sanitizeErrorText(safeStringify(entry.context, 2)));
  }
  // Use tilde fence so any backtick blocks inside the log body don't break the outer fence.
  return `${header}~~~log\n${body.join("\n")}\n~~~`;
}

export function LogEntry({ entry, isExpanded, onToggle, count = 1, copyMeta }: LogEntryProps) {
  const hasContext = entry.context && Object.keys(entry.context).length > 0;
  const contextPanelId = hasContext ? `context-${entry.id}` : undefined;
  const isoTime = new Date(entry.timestamp).toISOString();
  const isoTimeId = `log-time-${entry.id}`;

  const summary = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-text-secondary text-xs font-mono shrink-0">
            {formatTimestamp(entry.timestamp)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{isoTime}</TooltipContent>
      </Tooltip>

      <Badge
        size="xs"
        className={cn("w-11 justify-center py-px text-2xs uppercase", LEVEL_CHIP[entry.level])}
      >
        {entry.level}
      </Badge>

      {/* A fixed track, kept empty when there's no source, so every message
          starts in the same column. */}
      <span className="w-28 shrink-0 min-w-0 flex">
        {entry.source && (
          <TruncatedTooltip content={entry.source} focusable={false}>
            <span className="truncate text-text-secondary text-xs font-mono">{entry.source}</span>
          </TruncatedTooltip>
        )}
      </span>

      <span className="text-text-primary text-xs font-mono break-words min-w-0 flex-1">
        {entry.message}
      </span>

      {count > 1 && (
        <CountBadge className="mt-px" label={`repeated ${count} times`}>
          ×{count}
        </CountBadge>
      )}

      {hasContext && (
        <span className="text-text-secondary shrink-0" aria-hidden>
          <ChevronRight
            data-animated-chevron
            className={cn(
              "w-3 h-3 transition-transform duration-150 ease-out",
              isExpanded && "rotate-90"
            )}
          />
        </span>
      )}
    </>
  );

  // Time, level, source and repeat count belong in the name: they're what a
  // sighted reader scans the row for.
  const accessibleName = [
    formatTimestamp(entry.timestamp),
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
            // The tooltip's full timestamp is pointer-only; this is its keyboard twin.
            aria-describedby={isoTimeId}
            className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-[var(--radius-sm)] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
          >
            {summary}
            <span id={isoTimeId} className="sr-only">
              {isoTime}
            </span>
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-2">{summary}</div>
        )}

        <CopyButton
          text={() => buildCopyPayload(entry, count, copyMeta)}
          aria-label="Copy log entry"
          tooltip="Copy entry"
          // Shown with the row's pointer or keyboard focus, and kept on an
          // expanded row, which is the one being read for a report.
          className={cn(
            "-my-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-copied:opacity-100",
            isExpanded && "opacity-100"
          )}
        />
      </div>

      {isExpanded && hasContext && (
        <div
          id={contextPanelId}
          // `border-border-divider`, not the hand-written `.border-divider`: that
          // class lands after `border-l-*` and repaints the severity edge neutral.
          className={cn(
            "mt-1.5 mb-1 ml-[7.25rem] p-2 rounded-[var(--radius-md)] border border-l-2 text-xs font-mono overflow-x-auto bg-surface-canvas border-border-divider",
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
