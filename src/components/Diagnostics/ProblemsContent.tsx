import { useMemo, useCallback, useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useErrorStore, type AppError, type RetryAction } from "@/store";
import { Copy, Check, Lightbulb } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

const ERROR_TYPE_LABELS: Record<string, string> = {
  git: "Git",
  process: "Process",
  filesystem: "File",
  network: "Network",
  config: "Config",
  unknown: "Other",
};

const ERROR_TYPE_COLORS: Record<string, string> = {
  git: "text-status-warning",
  process: "text-status-warning",
  filesystem: "text-status-info",
  network: "text-status-info",
  config: "text-status-warning",
  unknown: "text-status-error",
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
  error: AppError;
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
  const typeColor = ERROR_TYPE_COLORS[error.type] || "text-status-error";
  const isRetrying = !!error.retryProgress;
  const canRetry = error.isTransient && error.retryAction && onRetry;
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
      console.error("Failed to copy to clipboard:", err);
    }
  };

  return (
    <>
      <tr
        className={cn(
          "hover:bg-canopy-border/50 transition-colors",
          isExpanded && "bg-canopy-border/30"
        )}
      >
        <td className="px-3 py-2 text-xs text-canopy-text/60 whitespace-nowrap">
          {formatTimestamp(error.timestamp)}
        </td>
        <td className={cn("px-3 py-2 text-xs whitespace-nowrap font-medium", typeColor)}>
          {typeLabel}
        </td>
        <td className="px-3 py-2 text-sm text-canopy-text max-w-md">
          <button
            onClick={onToggleExpand}
            className="text-left w-full hover:text-canopy-text transition-colors"
            aria-expanded={isExpanded}
            aria-controls={`error-details-${error.id}`}
          >
            <span className="truncate block">{error.message}</span>
            {error.recoveryHint && (
              <span className="flex items-center gap-1 mt-0.5 text-xs text-canopy-text/60">
                <Lightbulb className="w-3 h-3 shrink-0" />
                {error.recoveryHint}
              </span>
            )}
          </button>
        </td>
        <td className="px-3 py-2 text-xs text-canopy-text/60 whitespace-nowrap">
          {error.source || "-"}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          <div className="flex items-center gap-1">
            {isRetrying && onCancelRetry && (
              <>
                <span className="text-[10px] text-status-warning">
                  Retrying {error.retryProgress!.attempt}/{error.retryProgress!.maxAttempts}...
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCancelRetry();
                  }}
                  className="px-2 py-0.5 text-xs text-status-error hover:text-status-error/70 border border-status-error/50 hover:bg-status-error/10 rounded"
                >
                  Cancel
                </button>
              </>
            )}
            {!isRetrying && canRetry && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry();
                }}
                className="px-2 py-0.5 text-xs text-status-success hover:text-status-success/70 border border-status-success/50 hover:bg-status-success/10 rounded"
              >
                Retry
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDismiss();
              }}
              className="p-1 text-canopy-text/60 hover:text-canopy-text"
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        </td>
      </tr>
      {isExpanded && error.details && (
        <tr className="bg-canopy-sidebar/50" id={`error-details-${error.id}`}>
          <td colSpan={5} className="px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <pre className="text-xs text-canopy-text/60 whitespace-pre-wrap break-all font-mono max-h-40 overflow-y-auto flex-1 select-text">
                {error.details}
              </pre>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleCopyDetails}
                      className="shrink-0 p-1.5 text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-border/50 rounded transition-colors"
                      aria-label={
                        copied ? "Copied to clipboard" : "Copy error details to clipboard"
                      }
                    >
                      {copied ? (
                        <Check className="w-4 h-4 text-status-success" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {copied ? "Copied!" : "Copy error details"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            {error.context && Object.keys(error.context).length > 0 && (
              <div className="mt-2 text-xs text-canopy-text/60">
                <span className="font-medium">Context: </span>
                {Object.entries(error.context)
                  .filter(([, v]) => v !== undefined)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(", ")}
              </div>
            )}
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
        <div className="flex items-center justify-center h-full text-canopy-text/60 text-sm">
          No problems detected
        </div>
      ) : (
        <table className="w-full">
          <thead className="sticky top-0 bg-canopy-sidebar border-b border-canopy-border">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-canopy-text/60 w-24">
                Time
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-canopy-text/60 w-20">
                Type
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-canopy-text/60">
                Message
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-canopy-text/60 w-28">
                Source
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-canopy-text/60 w-24">
                Actions
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
