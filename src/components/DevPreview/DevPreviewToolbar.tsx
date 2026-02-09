import { RotateCw, ExternalLink, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DevPreviewStatus } from "./devPreviewTypes";

const STATUS_CONFIG: Record<DevPreviewStatus, { label: string; dotClass: string }> = {
  installing: {
    label: "Installing",
    dotClass: "bg-[var(--color-status-warning)]",
  },
  starting: {
    label: "Starting",
    dotClass: "bg-[var(--color-status-info)]",
  },
  running: {
    label: "Running",
    dotClass: "bg-[var(--color-status-success)]",
  },
  error: {
    label: "Error",
    dotClass: "bg-[var(--color-status-error)]",
  },
  stopped: {
    label: "Stopped",
    dotClass: "bg-canopy-text/40",
  },
};

interface DevPreviewToolbarProps {
  status: DevPreviewStatus;
  url: string | null;
  isRestarting?: boolean;
  onRestart: () => void;
  onOpenExternal?: () => void;
}

export function DevPreviewToolbar({
  status,
  url,
  isRestarting = false,
  onRestart,
  onOpenExternal,
}: DevPreviewToolbarProps) {
  const statusConfig = STATUS_CONFIG[status];
  const showSpinner = isRestarting || status === "starting" || status === "installing";

  const buttonClass =
    "p-1.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors";

  const handleOpenExternal = () => {
    if (url && onOpenExternal) {
      onOpenExternal();
    } else if (url && window.electron?.system?.openExternal) {
      void window.electron.system.openExternal(url).catch((err) => {
        console.error("Failed to open URL externally:", err);
      });
    }
  };

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-[var(--color-surface)] border-b border-overlay">
      {/* Status indicator */}
      <div className="flex items-center gap-2 min-w-0" role="status" aria-live="polite">
        <Server className="w-3.5 h-3.5 text-canopy-text/40 shrink-0" />
        <span
          className={cn("h-2 w-2 rounded-full shrink-0", statusConfig.dotClass)}
          title={statusConfig.label}
        />
        <span className="text-xs text-canopy-text/70 font-medium">{statusConfig.label}</span>
      </div>

      {/* URL display */}
      <div className="flex-1 min-w-0 mx-2">
        {url ? (
          <span className="text-xs font-mono text-canopy-text/50 truncate block" title={url}>
            {url}
          </span>
        ) : status === "error" || status === "stopped" ? (
          <span className="text-xs text-canopy-text/30 italic">No URL</span>
        ) : (
          <span className="text-xs text-canopy-text/30 italic">Detecting URL...</span>
        )}
      </div>

      {/* Action buttons */}
      <button
        type="button"
        onClick={onRestart}
        disabled={isRestarting || status === "starting" || status === "installing"}
        className={cn(buttonClass, showSpinner && "animate-spin")}
        title="Restart dev server"
        aria-label="Restart dev server"
        aria-busy={showSpinner}
      >
        <RotateCw className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={handleOpenExternal}
        disabled={!url}
        className={buttonClass}
        title="Open in browser"
        aria-label="Open in external browser"
      >
        <ExternalLink className="w-4 h-4" />
      </button>
    </div>
  );
}
