import React, { useState, useEffect, useRef } from "react";
import { AlertTriangle, RotateCcw, FolderEdit, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TerminalRestartError } from "@/types";

export interface TerminalErrorBannerProps {
  terminalId: string;
  error: TerminalRestartError;
  onUpdateCwd: (id: string) => void;
  onRetry: (id: string) => void;
  onTrash: (id: string) => void;
  className?: string;
}

function TerminalErrorBannerComponent({
  terminalId,
  error,
  onUpdateCwd,
  onRetry,
  onTrash,
  className,
}: TerminalErrorBannerProps) {
  const isCwdError = error.code === "ENOENT" && error.context?.failedCwd;
  const [isVisible, setIsVisible] = useState(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setIsVisible(true);
    });

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  return (
    <div
      className={cn(
        "flex flex-col gap-2 px-3 py-2 shrink-0",
        "bg-[color-mix(in_oklab,var(--color-status-error)_10%,transparent)]",
        "border-b border-[var(--color-status-error)]/20",
        "transition-all duration-150",
        "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2",
        className
      )}
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-status-error)]"
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-[var(--color-status-error)]">
            Terminal Restart Failed
          </span>
          <p className="text-xs text-[var(--color-status-error)]/80 mt-0.5">{error.message}</p>
          {error.context?.failedCwd && (
            <p className="text-xs font-mono text-[var(--color-status-error)]/60 mt-1 truncate">
              Directory: {error.context.failedCwd}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 ml-6">
        {error.recoverable && isCwdError && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onUpdateCwd(terminalId);
            }}
            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-canopy-accent/10 text-canopy-accent hover:bg-canopy-accent/20 rounded transition-colors"
            title="Update Working Directory"
            aria-label="Update working directory"
          >
            <FolderEdit className="w-3 h-3" aria-hidden="true" />
            Update Directory
          </button>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRetry(terminalId);
          }}
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-canopy-border text-canopy-text hover:bg-canopy-border/80 rounded transition-colors"
          title="Retry Restart"
          aria-label="Retry restart"
        >
          <RotateCcw className="w-3 h-3" aria-hidden="true" />
          Retry
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTrash(terminalId);
          }}
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-[var(--color-status-error)]/70 hover:text-[var(--color-status-error)] hover:bg-[var(--color-status-error)]/10 rounded transition-colors"
          title="Move to Trash"
          aria-label="Move to trash"
        >
          <Trash2 className="w-3 h-3" aria-hidden="true" />
          Trash
        </button>
      </div>
    </div>
  );
}

export const TerminalErrorBanner = React.memo(TerminalErrorBannerComponent);
