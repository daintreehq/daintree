import {
  RotateCw,
  ExternalLink,
  Loader2,
  CheckCircle2,
  XCircle,
  Circle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import type { DevPreviewStatus } from "./devPreviewTypes";

const STATUS_CONFIG: Record<
  DevPreviewStatus,
  { icon: LucideIcon; iconClass: string; ariaLabel: string }
> = {
  installing: {
    icon: Loader2,
    iconClass: "text-[var(--color-status-warning)] animate-spin",
    ariaLabel: "Installing dependencies",
  },
  starting: {
    icon: Loader2,
    iconClass: "text-[var(--color-status-info)] animate-spin",
    ariaLabel: "Starting dev server",
  },
  running: {
    icon: CheckCircle2,
    iconClass: "text-[var(--color-status-success)]",
    ariaLabel: "Dev server running",
  },
  error: {
    icon: XCircle,
    iconClass: "text-[var(--color-status-error)]",
    ariaLabel: "Dev server error",
  },
  stopped: {
    icon: Circle,
    iconClass: "text-canopy-text/40",
    ariaLabel: "Dev server stopped",
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
      <div
        className="flex items-center gap-1.5 min-w-0"
        role="status"
        aria-live="polite"
        aria-label={statusConfig.ariaLabel}
      >
        <statusConfig.icon
          className={cn("w-3.5 h-3.5 shrink-0", statusConfig.iconClass)}
          aria-hidden="true"
        />
      </div>

      {/* URL display */}
      <div className="flex-1 min-w-0 mx-2">
        {url ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-xs font-mono text-canopy-text/50 truncate block">{url}</span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{url}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : status === "error" || status === "stopped" ? (
          <span className="text-xs text-canopy-text/30 italic">No URL</span>
        ) : (
          <span className="text-xs text-canopy-text/30 italic">Detecting URL...</span>
        )}
      </div>

      {/* Action buttons */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <button
                type="button"
                onClick={onRestart}
                disabled={isRestarting || status === "starting" || status === "installing"}
                className={cn(buttonClass, showSpinner && "animate-spin")}
                aria-label="Restart dev server"
                aria-busy={showSpinner}
              >
                <RotateCw className="w-4 h-4" />
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Restart dev server</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <button
                type="button"
                onClick={handleOpenExternal}
                disabled={!url}
                className={buttonClass}
                aria-label="Open in external browser"
              >
                <ExternalLink className="w-4 h-4" />
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Open in browser</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
