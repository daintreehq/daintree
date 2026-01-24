import React, { useState, useEffect, useRef } from "react";
import { AlertTriangle, RotateCcw, FolderEdit, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SpawnError } from "@/types";

export interface SpawnErrorBannerProps {
  terminalId: string;
  error: SpawnError;
  cwd?: string;
  onUpdateCwd: (id: string) => void;
  onRetry: (id: string) => void;
  onTrash: (id: string) => void;
  className?: string;
}

function getErrorTitle(code: SpawnError["code"]): string {
  switch (code) {
    case "ENOENT":
      return "Shell or Command Not Found";
    case "EACCES":
      return "Permission Denied";
    case "ENOTDIR":
      return "Invalid Working Directory";
    case "EIO":
      return "PTY Allocation Failed";
    case "DISCONNECTED":
      return "Terminal Disconnected";
    default:
      return "Failed to Start Terminal";
  }
}

function getErrorDescription(error: SpawnError, cwd?: string): string {
  switch (error.code) {
    case "ENOENT":
      if (error.path) {
        return `Could not find: ${error.path}`;
      }
      return error.message;
    case "EACCES":
      return `You don't have permission to execute: ${error.path || "the shell"}`;
    case "ENOTDIR":
      return `The working directory is not valid: ${cwd || "(unknown)"}`;
    case "EIO":
      return "Failed to allocate a pseudo-terminal. The system may be running low on resources.";
    case "DISCONNECTED":
      return "The terminal process is no longer running. Click Retry to start a new session.";
    default:
      return error.message;
  }
}

function SpawnErrorBannerComponent({
  terminalId,
  error,
  cwd,
  onUpdateCwd,
  onRetry,
  onTrash,
  className,
}: SpawnErrorBannerProps) {
  const isCwdError = error.code === "ENOTDIR";
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
            {getErrorTitle(error.code)}
          </span>
          <p className="text-xs text-[var(--color-status-error)]/80 mt-0.5">
            {getErrorDescription(error, cwd)}
          </p>
          {cwd && (
            <p className="text-xs font-mono text-[var(--color-status-error)]/60 mt-1 truncate">
              Directory: {cwd}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 ml-6">
        {isCwdError && (
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
          title="Retry"
          aria-label="Retry starting terminal"
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

export const SpawnErrorBanner = React.memo(SpawnErrorBannerComponent);
