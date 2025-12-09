import React from "react";
import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TerminalRestartBannerProps {
  exitCode: number;
  onRestart: () => void;
  onDismiss: () => void;
  className?: string;
}

function TerminalRestartBannerComponent({
  exitCode,
  onRestart,
  onDismiss,
  className,
}: TerminalRestartBannerProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-3 py-2 shrink-0",
        "bg-[color-mix(in_oklab,var(--color-status-error)_10%,transparent)]",
        "border-b border-[var(--color-status-error)]/20",
        className
      )}
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 min-w-0">
        <AlertTriangle
          className="w-4 h-4 shrink-0 text-[var(--color-status-error)]"
          aria-hidden="true"
        />
        <span className="text-sm text-[var(--color-status-error)]">
          Session exited with code {exitCode}
        </span>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRestart();
          }}
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-[var(--color-status-error)]/10 text-[var(--color-status-error)] hover:bg-[var(--color-status-error)]/20 rounded transition-colors"
          title="Restart Session"
          aria-label="Restart session"
        >
          <RotateCcw className="w-3 h-3" aria-hidden="true" />
          Restart Session
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className="p-1 text-[var(--color-status-error)]/60 hover:text-[var(--color-status-error)] hover:bg-[var(--color-status-error)]/10 rounded transition-colors"
          title="Dismiss"
          aria-label="Dismiss restart prompt"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export const TerminalRestartBanner = React.memo(TerminalRestartBannerComponent);
