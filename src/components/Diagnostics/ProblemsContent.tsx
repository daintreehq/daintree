import { useMemo, useCallback, useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useErrorStore, type ErrorRecord, type RetryAction, RECURRENCE_THRESHOLD } from "@/store";
import { Copy, Check, ChevronRight, Lightbulb, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui/EmptyState";
import { logError } from "@/utils/logger";

const CONTEXT_LABELS: Record<string, string> = {
  worktreeId: "Worktree",
  terminalId: "Terminal",
  filePath: "File",
  command: "Command",
};

const ERROR_TYPE_LABELS: Record<string, string> = {
  git: "Git",
  process: "Process",
  filesystem: "File",
  network: "Network",
  config: "Config",
  validation: "Validation",
  unknown: "Other",
};

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

interface ErrorRowProps {
  error: ErrorRecord;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onDismiss: () => void;
  onRetry?: () => void;
  onCancelRetry?: () => void;
}

function ErrorRow({
  error,
  isExpanded,
  onToggleExpand,
  onDismiss,
  onRetry,
  onCancelRetry,
}: ErrorRowProps) {
  const typeLabel = ERROR_TYPE_LABELS[error.type] || "Error";
  const isRetrying = !!error.retryProgress;
  const canRetry =
    error.retryability === "auto" &&
    error.retryAction &&
    onRetry &&
    !error.retryExhausted &&
    (error.occurrenceCount ?? 0) < RECURRENCE_THRESHOLD;
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
    };
  }, [error.id]);

  const handleCopyDetails = async () => {
    const detailsText = [
      `Error: ${error.message}`,
      `Type: ${typeLabel}`,
      `Time: ${formatTimestamp(error.timestamp)}`,
      `Source: ${error.source || "unknown"}`,
      "",
      "Details:",
      error.details || "No additional details",
    ];

    if (error.context && Object.keys(error.context).length > 0) {
      detailsText.push("");
      detailsText.push("Context:");
      Object.entries(error.context)
        .filter(([, v]) => v !== undefined)
        .forEach(([k, v]) => detailsText.push(`  ${k}: ${v}`));
    }

    try {
      await navigator.clipboard.writeText(detailsText.join("\n"));
      setCopied(true);

      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }

      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
        copyTimeoutRef.current = null;
      }, 2000);
    } catch (err) {
      logError("Failed to copy to clipboard", err);
    }
  };

  const contextEntries = error.context
    ? Object.entries(error.context).filter(([, v]) => v !== undefined)
    : [];
  const recurrence =
    (error.occurrenceCount ?? 0) > 1 ? `Seen ${error.occurrenceCount} times` : undefined;
  const retriesStopped =
    error.retryExhausted || error.retryability === "exhausted"
      ? "automatic retries stopped"
      : undefined;
  const statusLine = [recurrence, retriesStopped].filter(Boolean).join(" · ");
  const detailsId = `error-details-${error.id}`;

  return (
    <>
      <tr
        className={cn(
          "group border-b border-divider align-top transition-colors",
          isExpanded ? "bg-overlay-subtle" : "hover:bg-overlay-subtle"
        )}
      >
        <td className="max-w-0 py-1.5 pl-2 pr-3">
          <button
            type="button"
            onClick={onToggleExpand}
            className="flex w-full min-w-0 items-start gap-1.5 rounded-[var(--radius-sm)] text-left text-text-primary hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
            aria-expanded={isExpanded}
            aria-controls={detailsId}
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "mt-0.5 h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform duration-150 ease-out",
                isExpanded && "rotate-90"
              )}
            />
            <span className="min-w-0 flex-1">
              <span className={cn("block text-sm", !isExpanded && "truncate")}>
                {error.message}
              </span>
              {isRetrying ? (
                <span className="mt-0.5 flex items-center gap-1 text-xs text-text-secondary">
                  <SpinningIcon icon={RefreshCw} active className="h-3 w-3 shrink-0" />
                  Retrying automatically (attempt {error.retryProgress!.attempt} of{" "}
                  {error.retryProgress!.maxAttempts})
                </span>
              ) : error.recoveryHint ? (
                <span className="mt-0.5 flex items-start gap-1 text-xs text-text-secondary">
                  <Lightbulb aria-hidden="true" className="mt-px h-3 w-3 shrink-0" />
                  <span className="sr-only">Suggestion: </span>
                  {error.recoveryHint}
                </span>
              ) : null}
              {statusLine ? (
                <span className="mt-0.5 block text-xs text-text-secondary">{statusLine}</span>
              ) : null}
            </span>
          </button>
        </td>
        <td className="whitespace-nowrap px-3 py-1.5 text-xs text-text-secondary">{typeLabel}</td>
        <td className="max-w-0 truncate px-3 py-1.5 text-xs text-text-secondary">
          {error.source || "—"}
        </td>
        <td className="whitespace-nowrap px-3 py-1.5 text-xs tabular-nums text-text-secondary">
          {formatTimestamp(error.timestamp)}
        </td>
        <td className="py-1 pl-1 pr-2">
          <div className="flex items-center justify-end gap-1">
            {isRetrying && onCancelRetry ? (
              <Button
                variant="subtle"
                size="xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancelRetry();
                }}
              >
                Cancel retry
              </Button>
            ) : null}
            {!isRetrying && canRetry ? (
              <Button
                variant="subtle"
                size="xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry();
                }}
              >
                Retry
              </Button>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDismiss();
                  }}
                  aria-label="Dismiss problem"
                >
                  <X />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Dismiss</TooltipContent>
            </Tooltip>
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b border-divider bg-overlay-subtle" id={detailsId}>
          <td colSpan={5} className="pb-2.5 pl-7 pr-3 pt-0">
            <div className="rounded-[var(--radius-md)] border border-divider bg-surface-canvas p-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  {error.details ? (
                    <pre className="max-h-40 select-text overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-text-primary">
                      {error.details}
                    </pre>
                  ) : (
                    <p className="text-xs text-text-secondary">No further details were recorded</p>
                  )}
                  {contextEntries.length > 0 ? (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                      {contextEntries.map(([k, v]) => (
                        <div key={k} className="contents">
                          <dt className="text-text-secondary">{CONTEXT_LABELS[k] ?? k}</dt>
                          <dd className="min-w-0 break-all font-mono text-text-primary">
                            {String(v)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </div>
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={handleCopyDetails}
                  aria-label={copied ? "Copied to clipboard" : "Copy error details to clipboard"}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Copied" : "Copy details"}
                </Button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export interface ProblemsContentProps {
  onRetry?: (id: string, action: RetryAction, args?: Record<string, unknown>) => void;
  onCancelRetry?: (id: string) => void;
  className?: string;
}

export function ProblemsContent({ onRetry, onCancelRetry, className }: ProblemsContentProps) {
  const errors = useErrorStore((state) => state.errors);
  const dismissError = useErrorStore((state) => state.dismissError);

  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  const activeErrors = useMemo(() => {
    return errors.filter((e) => !e.dismissed);
  }, [errors]);

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  return (
    <div className={cn("h-full overflow-auto", className)}>
      {activeErrors.length === 0 ? (
        <div className="flex h-full items-center justify-center">
          {errors.length > 0 ? (
            <EmptyState variant="user-cleared" scale="sidebar" title="Problems cleared" />
          ) : (
            <EmptyState variant="zero-data" scale="sidebar" title="No problems detected" />
          )}
        </div>
      ) : (
        <table className="w-full table-fixed border-collapse">
          <thead className="sticky top-0 z-10 bg-surface-sidebar">
            <tr className="border-b border-divider text-left text-2xs font-medium text-text-secondary">
              <th className="py-1 pl-7 pr-3 font-medium">Problem</th>
              <th className="w-20 px-3 py-1 font-medium">Type</th>
              <th className="w-36 px-3 py-1 font-medium">Source</th>
              <th className="w-20 px-3 py-1 font-medium">Time</th>
              <th className="w-36 py-1 pl-1 pr-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {activeErrors.map((error) => (
              <ErrorRow
                key={error.id}
                error={error}
                isExpanded={expandedIds.has(error.id)}
                onToggleExpand={() => handleToggleExpand(error.id)}
                onDismiss={() => dismissError(error.id)}
                onRetry={
                  error.retryAction && onRetry
                    ? () => onRetry(error.id, error.retryAction!, error.retryArgs)
                    : undefined
                }
                onCancelRetry={onCancelRetry ? () => onCancelRetry(error.id) : undefined}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
