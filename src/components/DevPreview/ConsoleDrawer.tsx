import { useState, useCallback, useEffect } from "react";
import { ChevronDown, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { XtermAdapter } from "../Terminal/XtermAdapter";
import { terminalInstanceService } from "../../services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import type { DevPreviewStatus } from "@/hooks/useDevServer";

interface ConsoleDrawerProps {
  terminalId: string;
  status?: DevPreviewStatus;
  defaultOpen?: boolean;
  isRestarting?: boolean;
  onHardRestart?: () => void;
}

const STATUS_LABEL: Record<DevPreviewStatus, { label: string; className: string }> = {
  stopped: { label: "Stopped", className: "text-canopy-text/40" },
  starting: { label: "Starting", className: "text-blue-400" },
  installing: { label: "Installing", className: "text-yellow-400" },
  running: { label: "Running", className: "text-green-400" },
  error: { label: "Error", className: "text-red-400" },
};

export function ConsoleDrawer({
  terminalId,
  status = "stopped",
  defaultOpen = false,
  isRestarting = false,
  onHardRestart,
}: ConsoleDrawerProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const toggleDrawer = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    terminalInstanceService.setVisible(terminalId, isOpen);
  }, [terminalId, isOpen]);

  const getRefreshTier = useCallback(() => {
    return isOpen ? TerminalRefreshTier.VISIBLE : TerminalRefreshTier.BACKGROUND;
  }, [isOpen]);

  const statusLabel = isRestarting
    ? { label: "Restarting", className: "text-blue-400" }
    : (STATUS_LABEL[status] ?? STATUS_LABEL.stopped);
  const toggleLabel = isOpen ? "Hide Terminal" : "Show Terminal";
  const hardRestartDisabled =
    !onHardRestart || isRestarting || status === "starting" || status === "installing";

  return (
    <div className="flex flex-col border-t border-overlay bg-[var(--color-surface)]">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2 py-2">
        <button
          type="button"
          onClick={toggleDrawer}
          className="flex min-h-10 min-w-0 items-center gap-2 rounded-md border border-overlay/70 bg-black/20 px-3 py-2 text-xs font-semibold text-canopy-text/80 transition-colors hover:bg-black/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-400"
          aria-expanded={isOpen}
          aria-controls={`console-drawer-${terminalId}`}
          aria-label={toggleLabel}
        >
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 transition-transform", isOpen && "rotate-180")}
            aria-hidden="true"
          />
          <span className="truncate">{toggleLabel}</span>
        </button>

        <div className="flex items-center gap-2">
          <div
            className={cn(
              "inline-flex min-h-10 items-center rounded-md border border-overlay/70 bg-black/20 px-3 text-[10px] font-semibold uppercase tracking-wide",
              statusLabel.className
            )}
            role="status"
            aria-live="polite"
          >
            {statusLabel.label}
          </div>

          {onHardRestart && (
            <button
              type="button"
              onClick={onHardRestart}
              disabled={hardRestartDisabled}
              className={cn(
                "flex min-h-10 shrink-0 items-center gap-2 rounded-md border border-overlay/70 bg-black/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-canopy-text/80 transition-colors",
                "hover:bg-black/30 disabled:cursor-not-allowed disabled:opacity-40",
                isRestarting && "text-blue-400"
              )}
              title="Hard restart dev preview"
              aria-label="Hard restart dev preview"
              aria-busy={isRestarting}
            >
              <RotateCw className={cn("h-3.5 w-3.5", isRestarting && "animate-spin")} />
              <span>Restart</span>
            </button>
          )}
        </div>
      </div>

      <div
        id={`console-drawer-${terminalId}`}
        className={cn("overflow-hidden transition-[height]", isOpen ? "h-[300px]" : "h-0")}
        aria-hidden={!isOpen}
      >
        <div className="h-[300px] bg-black">
          <XtermAdapter
            terminalId={terminalId}
            getRefreshTier={getRefreshTier}
            restoreOnAttach={true}
          />
        </div>
      </div>
    </div>
  );
}
